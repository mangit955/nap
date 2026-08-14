/**
 * One turn, end to end: get a sandbox, build the context, run the agent, write down
 * everything that happened, and commit the result.
 *
 * It owns the lifecycle and nothing inside it. No prompt text, no model parameters, no tool
 * implementations — those belong to the components it calls, and the ordering rules below
 * are the whole reason this layer exists.
 *
 * **Append, then publish — always.** Events reach the store before the bus, one at a time
 * and in the order they were emitted. A subscriber that received an event which was never
 * written would be shown history that does not exist, and it would then reconnect, replay
 * from the log, and find the event gone. The agent emits synchronously while persistence is
 * asynchronous, so the sink below serializes the two rather than letting them race.
 *
 * **A failed turn commits nothing.** The workspace stays at the last good commit, so a
 * refusal or a crash leaves a project someone can still open. This is structural rather
 * than a branch to remember: committing happens inside the `finalize` hook, and the agent
 * calls that hook on exactly one path — the one where the turn completed.
 *
 * **One turn at a time per session.** Two turns in the same chat would otherwise interleave
 * their events in the log and their edits in the workspace. Different sessions are
 * unaffected: the lock is per session, not per process.
 */

import { commitAll } from "@nap/sandbox/git";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import type { NapEvent, NapEventOf } from "@nap/shared/events";
import { addLogContext, getLogger, withLogContext } from "@nap/shared/logging";
import type { AgentService } from "@nap/shared/ports/agent-service";
import type { ContextEngine } from "@nap/shared/ports/context-engine";
import type { EventBus } from "@nap/shared/ports/event-bus";
import type { EventStore, PendingEvent } from "@nap/shared/ports/event-store";
import type { MemoryProvider } from "@nap/shared/ports/memory-provider";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { PageCapture } from "@nap/shared/ports/page-capture";
import type { ResumeOutcome, Runtime, TurnOutcome, TurnRequest } from "@nap/shared/ports/runtime";
import type { SandboxError, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SessionRecord, SessionStore } from "@nap/shared/ports/session-store";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
import type { Result } from "@nap/shared/result";
import {
  type AcquiredSandbox,
  acquireSandbox,
  type RestoreDeps,
  restoreDepsOf,
} from "./acquire-sandbox.ts";
import { EventSink } from "./event-sink.ts";
import { SessionQueue } from "./session-queue.ts";
import { captureSnapshot } from "./teardown.ts";
import { captureThumbnail } from "./turn-thumbnail.ts";

type Payload<T extends NapEvent["type"]> = NapEventOf<T>["payload"];

/** What a turn or a resume works within: whose project it is, and where its events go. */
type TurnScope = {
  session: SessionRecord;
  sink: EventSink;
  emit: <T extends NapEvent["type"]>(type: T, payload: Payload<T>) => void;
};

/** Git's own convention for a subject line, and what every log viewer is laid out for. */
const COMMIT_SUBJECT_LIMIT = 72;

/**
 * How long to wait for a newly created sandbox's dev server before getting on with the turn.
 * The project template serves in about two seconds from cold, so this leaves room for a slow
 * one without holding a turn hostage to it.
 */
const PREVIEW_TIMEOUT_MS = 20_000;

/**
 * How long a sandbox is kept alive after a turn touches it.
 *
 * Longer than the reaper's idle threshold on purpose: the reaper takes a snapshot before it
 * destroys anything, and the provider's own timer does not. Whichever fires first decides
 * whether an idle project is put away or simply lost, so this side has to be the slower one.
 */
const DEFAULT_SANDBOX_TTL_MS = 30 * 60 * 1000;

/**
 * What to say when a project could not be started back up.
 *
 * Names the thing that failed and says the work is still there, because the fear a person has
 * on seeing this is that their project is gone — and it is not: the snapshot is untouched by a
 * sandbox that would not start.
 */
function resumeFailureNotice(error: SandboxError): string {
  return (
    `Couldn't start this project back up: ${error.message}. ` +
    "Nothing has been lost — its files are still saved. Try again in a moment."
  );
}

export type SingleAgentRuntimeOptions = {
  sessions: SessionStore;
  sandbox: SandboxManager;
  context: ContextEngine;
  agent: AgentService;
  events: EventStore;
  bus: EventBus;
  memory: MemoryProvider;
  /**
   * Where a project's bytes and its snapshot rows live. Supply both to make a project
   * survive its sandbox; supply neither and a session without a live sandbox starts from
   * the bare template, which is all this could do before snapshots existed.
   */
  objects?: ObjectStore;
  snapshots?: SnapshotStore;
  /**
   * A browser, for the picture of the project the dashboard puts on its card.
   *
   * Optional and independent of the pair above: a deployment with no browser to drive still
   * runs turns and still keeps the work — it just shows a colour where a screenshot would be.
   * It needs `objects` to have anywhere to put the bytes, so both must be present or nothing
   * is captured.
   */
  capture?: PageCapture;
  /** Injected so a test can assert on whole events rather than on everything but the clock. */
  now?: () => string;
  /** Injected for the same reason: a turn id a test can predict. */
  newTurnId?: () => string;
  /** The port the project's dev server listens on. Defaults to the template's. */
  previewPort?: number;
  previewTimeoutMs?: number;
  /**
   * How long a resumed sandbox is kept alive for, in milliseconds.
   *
   * Must stay comfortably longer than whatever idle threshold the reaper uses, or the
   * provider's own timer wins the race and the project is destroyed without a snapshot.
   */
  sandboxTtlMs?: number;
};

export class SingleAgentRuntime implements Runtime {
  readonly #options: SingleAgentRuntimeOptions;
  readonly #now: () => string;
  readonly #newTurnId: () => string;
  readonly #previewPort: number;
  readonly #previewTimeoutMs: number;
  readonly #sandboxTtlMs: number;
  readonly #restore: RestoreDeps | null;
  /** One turn at a time per session; see `session-queue.ts`. */
  readonly #queue = new SessionQueue();

  constructor(options: SingleAgentRuntimeOptions) {
    this.#options = options;
    this.#restore = restoreDepsOf(options);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newTurnId = options.newTurnId ?? (() => crypto.randomUUID());
    this.#previewPort = options.previewPort ?? TEMPLATE_DEV_PORT;
    this.#previewTimeoutMs = options.previewTimeoutMs ?? PREVIEW_TIMEOUT_MS;
    this.#sandboxTtlMs = options.sandboxTtlMs ?? DEFAULT_SANDBOX_TTL_MS;
  }

  runTurn(request: TurnRequest): Promise<TurnOutcome> {
    return this.#queue.run(request.sessionId, () => this.#runTurn(request));
  }

  /**
   * Starting a project back up, without a turn and without a model.
   *
   * On the same queue as a turn, which is what makes it safe to offer at all: both paths
   * create a sandbox when the project has none, and a page that resumes on arrival while its
   * user types a message asks for both at once. Serialized, the second one finds the first
   * one's sandbox; run in parallel, they would each start one and the project would end up
   * with two, one of which nobody can find and nobody stops paying for.
   */
  resumeSession(sessionId: string): Promise<ResumeOutcome> {
    return this.#queue.run(sessionId, () => this.#resume(sessionId));
  }

  /**
   * Opens the turn's log context before anything else happens in it.
   *
   * Everything below here — the sandbox manager, the context engine, the agent's loop — takes
   * no logger and cannot be given one without changing its interface, so the ids travel
   * ambiently instead. The context is opened around the whole turn rather than around each
   * step, because a turn is one long async chain and `AsyncLocalStorage` follows it across
   * every `await`, including the ones that outlive the request that started it.
   */
  async #runTurn(request: TurnRequest): Promise<TurnOutcome> {
    const turnId = this.#newTurnId();
    return await withLogContext(getLogger(), { sessionId: request.sessionId, turnId }, () =>
      this.#runTurnLogged(request, turnId),
    );
  }

  /** The same log context a turn gets, around a lifecycle operation that has no turn id. */
  async #resume(sessionId: string): Promise<ResumeOutcome> {
    const turnId = this.#newTurnId();
    return await withLogContext(getLogger(), { sessionId, turnId }, () =>
      this.#resumeLogged(sessionId, turnId),
    );
  }

  /**
   * What a turn and a resume both start with: the session, the log context, and somewhere to put
   * events.
   *
   * `null` when there is no such session — the caller turns that into its own kind of failure,
   * because a turn reports one and a resume reports the other. **Neither emits an event for it:**
   * an event needs a session to belong to, and there is nobody subscribed to one that was never
   * opened.
   */
  async #open(sessionId: string, turnId: string): Promise<TurnScope | null> {
    const session = await this.#options.sessions.get(sessionId);
    if (session === null) return null;

    // Known only now, and worth having on every line below: a project is what an operator is
    // asked about, and a session is an implementation detail of one.
    addLogContext({ projectId: session.projectId });

    const sink = new EventSink(this.#options.events, this.#options.bus);
    const emit = <T extends NapEvent["type"]>(type: T, payload: Payload<T>): void => {
      sink.emit({ type, payload, sessionId, turnId, createdAt: this.#now() } as PendingEvent);
    };

    return { session, sink, emit };
  }

  async #resumeLogged(sessionId: string, turnId: string): Promise<ResumeOutcome> {
    const scope = await this.#open(sessionId, turnId);

    if (scope === null) {
      getLogger().warn("resume refused: no such session");
      return { ok: false, reason: "internal", message: `unknown session ${sessionId}` };
    }

    const { session, sink, emit } = scope;

    try {
      const acquired = await this.#acquire(session);

      if (!acquired.ok) {
        // A notice, not a `turn.failed`. No turn ran, so a failed one would put a retry button
        // under a conversation that never happened — and the preview pane reads a sandbox
        // failure as the state of the *last turn*, which nothing here is.
        emit("system.notice", { level: "warning", text: resumeFailureNotice(acquired.error) });
        await sink.drain();
        getLogger().warn({ reason: acquired.error.code }, "could not resume the project");
        return { ok: false, reason: "sandbox_unavailable", message: acquired.error.message };
      }

      for (const notice of acquired.value.notices) emit("system.notice", notice);

      // Only for a sandbox this just created. One that was already serving has its
      // `preview.ready` in the log already, and re-announcing remounts the frame underneath
      // whoever is using the app.
      if (acquired.value.created) await this.#announcePreview(acquired.value.id, emit);

      await sink.drain();
      getLogger().info({ created: acquired.value.created }, "project resumed");

      // A project that has just come back up is serving again, and its card may be showing
      // nothing at all — every project made before there was a browser to photograph one has
      // no picture, and a turn is the only other thing that would take it. Gated on the same
      // condition as the announcement above: a sandbox that was already serving has not
      // changed since whatever last photographed it.
      //
      // Last, and after the outcome is already decided: resuming is what the caller asked for,
      // and a browser launch must not be able to delay or fail it.
      if (acquired.value.created) await this.#photograph(session.projectId, acquired.value.id);

      return { ok: true, sandboxId: acquired.value.id, created: acquired.value.created };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger().error({ err: error }, "could not resume the project");
      return { ok: false, reason: "internal", message };
    }
  }

  async #runTurnLogged(request: TurnRequest, turnId: string): Promise<TurnOutcome> {
    const scope = await this.#open(request.sessionId, turnId);

    if (scope === null) {
      getLogger().warn("turn refused: no such session");
      return {
        ok: false,
        turnId,
        reason: "internal",
        message: `unknown session ${request.sessionId}`,
      };
    }

    const { session, sink, emit } = scope;
    getLogger().info({ chars: request.message.length }, "turn started");

    try {
      const sandboxId = await this.#acquire(session);
      if (!sandboxId.ok) {
        emit("turn.failed", { reason: "sandbox_unavailable", message: sandboxId.error.message });
        await sink.drain();
        return {
          ok: false,
          turnId,
          reason: "sandbox_unavailable",
          message: sandboxId.error.message,
        };
      }

      // Read before the message is logged: the context engine appends the turn's own message
      // itself, so finding it in the history too would send it to the model twice.
      const history = await this.#options.events.readFrom(request.sessionId, 0);
      emit("user.message", { text: request.message });

      // Before the preview, which is about to show whatever state the notice is explaining.
      for (const notice of sandboxId.value.notices) emit("system.notice", notice);

      // Only for a sandbox this turn created. A resumed one is already serving and announced
      // itself on the turn that made it — the client replays that. Re-announcing would reload
      // the app underneath someone in the middle of using it, on every turn.
      if (sandboxId.value.created) await this.#announcePreview(sandboxId.value.id, emit);

      const context = await this.#options.context.build({
        sessionId: request.sessionId,
        sandboxId: sandboxId.value.id,
        userMessage: request.message,
        history,
        sandbox: this.#options.sandbox,
        memory: this.#options.memory,
      });

      await this.#options.agent.runTurn({
        sessionId: request.sessionId,
        turnId,
        sandboxId: sandboxId.value.id,
        context,
        sandbox: this.#options.sandbox,
        onEvent: sink.emit,
        finalize: () => this.#commit(sandboxId.value.id, request.message),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.model === undefined ? {} : { model: request.model }),
        // Passed straight through and read nowhere here: the runtime decides *when* a turn
        // runs, never who pays for it.
        ...(request.credentials === undefined ? {} : { credentials: request.credentials }),
      });

      await sink.drain();

      const terminal = sink.terminal;
      if (terminal?.type === "turn.completed") {
        await this.#preserve(session.projectId, sandboxId.value.id, terminal.payload.commitSha);
        // After the snapshot, deliberately: the work reaching storage is what must not be
        // delayed by a browser launch, and a picture is the one thing here nobody would miss.
        // Only when the turn changed something — an unchanged app photographs identically.
        if (terminal.payload.commitSha !== null) {
          await this.#photograph(session.projectId, sandboxId.value.id);
        }
        return { ok: true, turnId, commitSha: terminal.payload.commitSha };
      }
      if (terminal?.type === "turn.failed") {
        return { ok: false, turnId, ...terminal.payload };
      }

      // The agent is supposed to end a turn exactly once. If it did not, the log would show
      // a turn that never closed, and anything replaying it would wait forever.
      const message = "the agent ended the turn without reporting an outcome";
      emit("turn.failed", { reason: "internal", message });
      await sink.drain();
      return { ok: false, turnId, reason: "internal", message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Only if the turn is not already closed — a thrown error after a `turn.failed` would
      // otherwise close the same turn twice.
      if (sink.terminal === null) {
        emit("turn.failed", { reason: "internal", message });
        // Best effort: if persistence is what broke, there is nowhere left to record it.
        await sink.drain().catch(() => {});
      }

      return { ok: false, turnId, reason: "internal", message };
    }
  }

  /**
   * Puts the turn's work somewhere that outlives the sandbox.
   *
   * **A sandbox is the only copy of a project until this runs.** It used to run only when
   * someone closed the project or the reaper swept it — and the reaper lives in this process,
   * so anything that stopped the process left the provider's own timer to delete the work.
   * That is the window every deploy sits in. Snapshotting here closes it: the cost is one
   * bundle and one upload per turn, against losing everything since the last time a project
   * happened to go idle.
   *
   * Deliberately after the turn's terminal event is persisted and published, so nothing the
   * user is waiting on is held up by it — the caller answers the request long before this and
   * runs the turn detached.
   *
   * **Only for a turn that committed.** `null` means the turn changed no files, and a git
   * bundle holds commits rather than a working tree, so there would be nothing new in it.
   *
   * **A failure here never fails the turn.** The turn happened, and its work is still in the
   * live sandbox with the reaper as a backstop; discarding a completed turn to report a backup
   * problem would be the worse trade. It is not told to the user either — there is no action
   * for them to take, and a warning nobody can act on is what teaches people to ignore the
   * warnings that matter.
   */
  async #preserve(projectId: string, sandboxId: string, commitSha: string | null): Promise<void> {
    if (this.#restore === null || commitSha === null) return;

    const captured = await captureSnapshot({
      sandbox: this.#options.sandbox,
      objects: this.#restore.objects,
      snapshots: this.#restore.snapshots,
      projectId,
      sandboxId,
    }).catch((error: unknown) => ({ ok: false as const, error: { message: String(error) } }));

    if (captured.ok) {
      getLogger().info({ key: captured.value.key, commitSha }, "turn snapshotted");
      return;
    }

    getLogger().warn(
      { commitSha, reason: captured.error.message },
      "could not snapshot the turn; the work is still only in the sandbox",
    );
  }

  /**
   * Photographs the project while it is still up, for the dashboard's card.
   *
   * **A picture can only be taken while a sandbox lives**, and the card is looked at days
   * later, when nothing is running to point a browser at. So every moment the project is
   * known to be serving is a chance worth taking: the end of a turn that changed something,
   * and a project coming back up. Putting one away takes its own shot from `close-project.ts`,
   * on the way past.
   *
   * Whoever calls decides *whether* there is anything new to see — a turn that committed
   * nothing, or a sandbox that was already serving, has not changed since the last shot. What
   * this owns is that a failure is only ever a log line: a missing screenshot costs a card its
   * picture, and nothing here is worth failing a turn or a resume over.
   */
  async #photograph(projectId: string, sandboxId: string): Promise<void> {
    const capture = this.#options.capture;
    const objects = this.#options.objects;
    if (capture === undefined || objects === undefined) return;

    const shot = await captureThumbnail({
      sandbox: this.#options.sandbox,
      capture,
      objects,
      projectId,
      sandboxId,
      port: this.#previewPort,
    }).catch((error: unknown) => ({ ok: false as const, error: { message: String(error) } }));

    if (shot.ok) {
      getLogger().info({ key: shot.value.key }, "project thumbnail captured");
      return;
    }

    getLogger().warn({ reason: shot.error.message }, "could not capture a project thumbnail");
  }

  /**
   * Tells the client where the project is served, once something actually answers there.
   *
   * `waitForPreview` rather than `getPreviewUrl`: the second only composes an address, and a
   * preview shown before the dev server and its public proxy are both up is an error page.
   *
   * A timeout is not a turn failure. A slow dev server is no reason to refuse to edit the
   * project — the pane keeps showing that it is starting, and the agent gets on with the work.
   */
  async #announcePreview(
    sandboxId: string,
    emit: (type: "preview.ready", payload: Payload<"preview.ready">) => void,
  ): Promise<void> {
    const port = this.#previewPort;
    const ready = await this.#options.sandbox.waitForPreview(sandboxId, port, {
      timeoutMs: this.#previewTimeoutMs,
    });
    if (ready.ok) emit("preview.ready", { url: ready.value, port });
  }

  /** See `acquire-sandbox.ts`, which owns the four paths and their ordering. */
  async #acquire(session: SessionRecord): Promise<Result<AcquiredSandbox, SandboxError>> {
    return await acquireSandbox(
      {
        sandbox: this.#options.sandbox,
        sessions: this.#options.sessions,
        restore: this.#restore,
        ttlMs: this.#sandboxTtlMs,
      },
      session,
    );
  }

  /**
   * Commits whatever the turn changed, for the agent to report in `turn.completed`.
   *
   * Throws when the commit fails, rather than returning "no commit". The two are not the
   * same thing: `null` means the turn changed nothing, and reporting a successful turn that
   * silently lost its changes is the worse of the two lies.
   */
  async #commit(sandboxId: string, message: string): Promise<{ commitSha: string | null }> {
    const committed = await commitAll(this.#options.sandbox, sandboxId, commitMessage(message));
    if (!committed.ok) {
      throw new Error(`could not commit the turn's changes: ${committed.error.message}`);
    }
    return { commitSha: committed.value.sha };
  }
}

/**
 * The commit subject for a turn: what the user asked for, on one line.
 *
 * A project's git history is the record of the conversation that produced it, so the request
 * is a better subject than anything generated. Long messages are truncated instead of being
 * wrapped into the body, because a subject line is what every log viewer shows.
 */
export function commitMessage(message: string): string {
  const [firstLine = ""] = message.trim().split("\n");
  const subject = firstLine.trim();

  if (subject === "") return "Nap turn";
  if (subject.length <= COMMIT_SUBJECT_LIMIT) return subject;

  return `${subject.slice(0, COMMIT_SUBJECT_LIMIT - 1)}…`;
}
