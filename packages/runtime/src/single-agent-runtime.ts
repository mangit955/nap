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
import type { AgentService } from "@nap/shared/ports/agent-service";
import type { ContextEngine } from "@nap/shared/ports/context-engine";
import type { EventBus } from "@nap/shared/ports/event-bus";
import type { EventStore, PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import type { MemoryProvider } from "@nap/shared/ports/memory-provider";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { Runtime, TurnOutcome, TurnRequest } from "@nap/shared/ports/runtime";
import type { SandboxError, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SessionRecord, SessionStore } from "@nap/shared/ports/session-store";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
import type { Result } from "@nap/shared/result";
import { openProject } from "./restore.ts";

type Payload<T extends NapEvent["type"]> = NapEventOf<T>["payload"];

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

/** A sandbox to work in, whether this turn created it, and anything the user should be told. */
type AcquiredSandbox = {
  id: string;
  created: boolean;
  notices: { level: "info" | "warning"; text: string }[];
};

/**
 * What a project is restored from. Both halves or neither: the bytes live in one and the
 * record of which bytes in the other, and one without the other cannot open anything.
 */
type RestoreDeps = { objects: ObjectStore; snapshots: SnapshotStore };

const LOST_SANDBOX_WARNING =
  "This project's sandbox was no longer available, so it was restored from its last " +
  "snapshot. Anything changed since then is not in it.";

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
  /** The tail of each session's queue. Absent means nothing is running for that session. */
  readonly #queues = new Map<string, Promise<unknown>>();

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
    const previous = this.#queues.get(request.sessionId) ?? Promise.resolve();
    const outcome = previous.then(() => this.#runTurn(request));

    // The queue tail swallows failures: one turn that rejected must not reject the turn
    // queued behind it, which is a different session's worth of surprise.
    const tail = outcome.then(
      () => {},
      () => {},
    );
    this.#queues.set(request.sessionId, tail);
    void tail.then(() => {
      // Only if nothing else has queued behind us; otherwise this is now someone else's tail.
      if (this.#queues.get(request.sessionId) === tail) this.#queues.delete(request.sessionId);
    });

    return outcome;
  }

  async #runTurn(request: TurnRequest): Promise<TurnOutcome> {
    const turnId = this.#newTurnId();
    const session = await this.#options.sessions.get(request.sessionId);

    if (session === null) {
      // No event, deliberately. An event needs a session to belong to — the log's rows point
      // at one — and there is nobody subscribed to a session that was never opened.
      return {
        ok: false,
        turnId,
        reason: "internal",
        message: `unknown session ${request.sessionId}`,
      };
    }

    const sink = new EventSink(this.#options.events, this.#options.bus);
    const emit = <T extends NapEvent["type"]>(type: T, payload: Payload<T>): void => {
      sink.emit({
        type,
        payload,
        sessionId: request.sessionId,
        turnId,
        createdAt: this.#now(),
      } as PendingEvent);
    };

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
      });

      await sink.drain();

      const terminal = sink.terminal;
      if (terminal?.type === "turn.completed") {
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

  /**
   * The sandbox this session's project is served from, resumed if there is one already.
   *
   * A recorded sandbox that cannot be resumed is only survivable because a snapshot can be
   * restored into a new one — and the user is told, because the snapshot is from the last
   * time the project was put away and anything after that is genuinely gone. Without
   * somewhere to restore *from*, this still fails the turn: a fresh sandbox would be an empty
   * template, and the user would be told their turn succeeded and shown a project with their
   * work missing.
   */
  async #acquire(session: SessionRecord): Promise<Result<AcquiredSandbox, SandboxError>> {
    if (session.sandboxId !== null) {
      const resumed = await this.#options.sandbox.resume(session.sandboxId);
      if (resumed.ok) {
        // Every provider kills a sandbox on a timer that starts when it was created, not when
        // it was last used, so a conversation that goes on longer than the budget would lose
        // its workspace mid-sentence. A turn is exactly the signal that someone is still here.
        // The result is deliberately not checked: the sandbox has just answered a resume, and
        // failing a turn over a keepalive would trade a small risk for a certain outage.
        await this.#options.sandbox.extendTimeout(resumed.value.id, this.#sandboxTtlMs);
        return { ok: true, value: { id: resumed.value.id, created: false, notices: [] } };
      }
      if (this.#restore === null) return resumed;

      const reopened = await this.#open(session);
      if (!reopened.ok) return reopened;
      reopened.value.notices.unshift({ level: "warning", text: LOST_SANDBOX_WARNING });
      return reopened;
    }

    return this.#open(session);
  }

  /** A new sandbox for this session's project, holding whatever could be restored into it. */
  async #open(session: SessionRecord): Promise<Result<AcquiredSandbox, SandboxError>> {
    if (this.#restore === null) {
      const created = await this.#options.sandbox.create(session.projectId);
      if (!created.ok) return created;

      await this.#options.sessions.setSandboxId(session.sessionId, created.value.id);
      return { ok: true, value: { id: created.value.id, created: true, notices: [] } };
    }

    const opened = await openProject({
      sandbox: this.#options.sandbox,
      objects: this.#restore.objects,
      snapshots: this.#restore.snapshots,
      projectId: session.projectId,
    });
    if (!opened.ok) {
      // Flattened to the one code a turn can report. The distinction between "no sandbox" and
      // "no snapshot" matters to whoever reads the message, not to the failure itself.
      return { ok: false, error: { code: "unavailable", message: opened.error.message } };
    }

    await this.#options.sessions.setSandboxId(session.sessionId, opened.value.sandboxId);
    return {
      ok: true,
      value: {
        id: opened.value.sandboxId,
        created: true,
        notices:
          opened.value.warning === null ? [] : [{ level: "warning", text: opened.value.warning }],
      },
    };
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
 * Half a restore is not a smaller restore, it is a bug — a store of bytes nothing can name,
 * or names with nothing behind them. Thrown rather than returned: this is a wiring mistake at
 * construction, not something a turn could recover from.
 */
function restoreDepsOf(options: SingleAgentRuntimeOptions): RestoreDeps | null {
  const { objects, snapshots } = options;
  if (objects === undefined && snapshots === undefined) return null;
  if (objects === undefined || snapshots === undefined) {
    throw new Error(
      "SingleAgentRuntime needs both `objects` and `snapshots` to restore a project, or neither.",
    );
  }
  return { objects, snapshots };
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

/**
 * Turns a stream of synchronous emissions into an ordered append-then-publish pipeline.
 *
 * `onEvent` cannot be awaited — the agent calls it mid-loop and carries on — but appending is
 * a database write. Queuing each event onto a promise chain gives three things at once:
 * appends happen in emission order, an event is published only after its own append has
 * returned, and `drain()` gives the turn a point at which everything it emitted is durable.
 *
 * The first failure stops the pipeline. Continuing would publish events whose predecessors
 * were never written, which is the exact hole this ordering exists to close.
 */
class EventSink {
  #chain: Promise<void> = Promise.resolve();
  #failure: unknown = null;
  #terminal: NapEventOf<"turn.completed"> | NapEventOf<"turn.failed"> | null = null;

  constructor(
    private readonly store: EventStore,
    private readonly bus: EventBus,
  ) {}

  /** How the turn ended, as recorded — null until it has. */
  get terminal(): NapEventOf<"turn.completed"> | NapEventOf<"turn.failed"> | null {
    return this.#terminal;
  }

  readonly emit = (event: PendingEvent): void => {
    this.#chain = this.#chain.then(async () => {
      if (this.#failure !== null) return;
      try {
        const stored = await this.store.append(event);
        this.bus.publish(stored);
        this.#record(stored);
      } catch (error) {
        this.#failure = error;
      }
    });
  };

  /** Resolves once every event emitted so far is persisted and published. */
  async drain(): Promise<void> {
    await this.#chain;
    if (this.#failure !== null) throw this.#failure;
  }

  #record(event: StoredEvent): void {
    if (event.type === "turn.completed" || event.type === "turn.failed") this.#terminal = event;
  }
}
