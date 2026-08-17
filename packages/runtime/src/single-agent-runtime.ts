/**
 * One turn, end to end: get a sandbox, build the context, run the agent, write down
 * everything that happened, commit the result, and ask the project whether it holds up.
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
 *
 * **A completed turn is the model's claim; verification arbitrates it.** A turn that changed
 * the workspace is committed exactly as before and then checked, and only a passing check
 * makes the commit a checkpoint. This sits *above* the invariant two paragraphs up rather than
 * changing it: a failed turn still commits nothing, and a turn that changed nothing is never
 * verified at all. See `#arbitrate` below, and `docs/adr/0006`.
 *
 * **A repair is a Turn**, and that is why this file grew a loop and nothing else. A red
 * verification prompts another turn on the same job, carrying the failure; that turn gets the
 * same budgets, the same cancellation, the same event ordering and the same commit-on-completion
 * as the one that opened the job, because it is the same kind of thing. Bounded at three, and
 * exhaustion reverts nothing — the code stays committed with `HEAD` diverged from the last
 * checkpoint, which is a state the user can usually close with one sentence.
 */

import { commitAll } from "@nap/sandbox/git";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import type { JobOutcome, NapEvent, NapEventOf, PromptSource } from "@nap/shared/events";
import { foldJobs, MAX_REPAIR_ATTEMPTS } from "@nap/shared/job-state";
import { addLogContext, getLogger, withLogContext } from "@nap/shared/logging";
import type { AgentService } from "@nap/shared/ports/agent-service";
import type { ContextEngine, FailedAttempt, JobContext } from "@nap/shared/ports/context-engine";
import type { EventBus } from "@nap/shared/ports/event-bus";
import type { EventStore, PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import type { ModelCredentials } from "@nap/shared/ports/llm-provider";
import type { MemoryProvider } from "@nap/shared/ports/memory-provider";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { PageCapture } from "@nap/shared/ports/page-capture";
import type {
  ContinueOptions,
  ResumeOutcome,
  Runtime,
  TurnOutcome,
  TurnRequest,
} from "@nap/shared/ports/runtime";
import type { SandboxError, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SessionRecord, SessionStore } from "@nap/shared/ports/session-store";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
import type { Result } from "@nap/shared/result";
import type { VerificationResult } from "@nap/verify/run-checks";
import {
  type AcquiredSandbox,
  acquireSandbox,
  type RestoreDeps,
  restoreDepsOf,
} from "./acquire-sandbox.ts";
import { continuationFor } from "./continue-job.ts";
import { EventSink } from "./event-sink.ts";
import { repairCommitSubject, repairPrompt } from "./repair-prompt.ts";
import { SessionQueue } from "./session-queue.ts";
import { captureSnapshot } from "./teardown.ts";
import { captureThumbnail } from "./turn-thumbnail.ts";
import { type CheckFailure, failureOf, toVerifiedChecks, verifyTurn } from "./verify-turn.ts";

type Payload<T extends NapEvent["type"]> = NapEventOf<T>["payload"];

/**
 * What a turn or a resume works within: whose project it is, where its events go, and which
 * turn they belong to.
 *
 * A job is several turns through one sink — the prompt, then up to three repairs — so the
 * `turnId` is on the scope rather than on the sink, and each repair gets a scope of its own.
 */
type TurnScope = {
  session: SessionRecord;
  sink: EventSink;
  turnId: string;
  emit: <T extends NapEvent["type"]>(type: T, payload: Payload<T>) => void;
};

/**
 * Everything a turn of a job is run with apart from its prompt.
 *
 * Narrower than `TurnRequest` because a continued job has no message: what it inherits from
 * whoever opened the project is the signal, the model and whose account pays, and nothing else.
 */
type TurnSettings = {
  sessionId: string;
  signal?: AbortSignal | undefined;
  model?: string | undefined;
  credentials?: ModelCredentials | undefined;
};

/**
 * A job in flight, and what it is doing right now.
 *
 * Mutable, and held by whoever started it: the loop moves `turn` on with each repair and clears
 * `open` when it writes the `job.completed`, and the caller's catch has to be able to read both
 * — a throw can land between one turn ending and the next beginning.
 */
type JobRun = {
  settings: TurnSettings;
  session: SessionRecord;
  sink: EventSink;
  sandboxId: string;
  jobId: string;
  objective: string;
  /** Failures already responded to, oldest first — the one thing a repair cannot rederive. */
  attempts: FailedAttempt[];
  /** Repair turns already spent. Non-zero for a job a restart is continuing. */
  repairs: number;
  /** The turn the job is running right now. */
  turn: TurnScope;
  /** False once a `job.completed` has been written for it. */
  open: boolean;
};

/**
 * Where the loop is picked up: after a turn this process just ran, or at whatever a restart
 * found in the log. See `continue-job.ts`.
 */
type JobEntry = {
  /** The turn to arbitrate — or, for a continued job, the commit it left behind. */
  outcome: TurnOutcome;
  /** A failure already recorded, to repair from without asking the project again. */
  failed: CheckFailure | null;
  /** Whether the first round writes its own `verification.started`. */
  announce: boolean;
  /**
   * Whether that first arbitration follows a turn this loop ran, and so has work to snapshot
   * and something new to photograph. False for a continuation: it is arbitrating a commit that
   * was preserved before the process died.
   */
  fresh: boolean;
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
  /**
   * Whether a completed turn's claim is arbitrated, or simply believed. Defaults to arbitrating.
   *
   * **This exists for one caller and it is not a deployment.** NapBench measures a difference by
   * running the same tasks with the loop and without it, and an arm that could only be built by
   * checking out an older Nap would differ from the other arm in every commit between them
   * rather than in the one thing being measured (docs/adr/0004, and the harness identity on the
   * report). `trust` *is* v1's behaviour: the turn commits, and the job closes `unverified`,
   * which is the same word a turn that changed nothing already closes with — no claim about the
   * code was arbitrated, and it must not read as a pass.
   *
   * Two words rather than a boolean, so that neither value can be arrived at by a stray `false`
   * and so that reading a composition tells you which one it asked for.
   */
  verification?: "arbitrate" | "trust";
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
   * Starting a project back up — and continuing the job a restart left open in it.
   *
   * On the same queue as a turn, which is what makes it safe to offer at all: both paths
   * create a sandbox when the project has none, and a page that resumes on arrival while its
   * user types a message asks for both at once. Serialized, the second one finds the first
   * one's sandbox; run in parallel, they would each start one and the project would end up
   * with two, one of which nobody can find and nobody stops paying for.
   *
   * **This is the only thing that continues a job, and that is the design.** A process restart
   * leaves a job open rather than failing it, and nothing sweeps for those: an autonomous loop
   * that spends tokens with nobody watching is a bill, and a crash loop plus auto-continue is a
   * large one. Somebody opening the project is the signal that a person is there.
   */
  resumeSession(sessionId: string, options: ContinueOptions = {}): Promise<ResumeOutcome> {
    return this.#queue.run(sessionId, () => this.#resume(sessionId, options));
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
  async #resume(sessionId: string, options: ContinueOptions): Promise<ResumeOutcome> {
    const turnId = this.#newTurnId();
    return await withLogContext(getLogger(), { sessionId, turnId }, () =>
      this.#resumeLogged(sessionId, turnId, options),
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

    return this.#scopeFor(session, sink, sessionId, turnId);
  }

  /** The same session and the same sink, under a different turn — what a repair runs in. */
  #scopeFor(session: SessionRecord, sink: EventSink, sessionId: string, turnId: string): TurnScope {
    const emit = <T extends NapEvent["type"]>(type: T, payload: Payload<T>): void => {
      sink.emit({ type, payload, sessionId, turnId, createdAt: this.#now() } as PendingEvent);
    };

    return { session, sink, turnId, emit };
  }

  async #resumeLogged(
    sessionId: string,
    turnId: string,
    options: ContinueOptions,
  ): Promise<ResumeOutcome> {
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

      // Last of all, and after everything the caller asked for is done: continuing a job runs
      // turns, which take minutes, and the project is up and usable the whole time. The caller
      // does not wait on this — `POST /projects/:id/open` has already answered — but the queue
      // does, which is what stops a message sent during a continuation interleaving with it.
      await this.#continue(scope, acquired.value.id, options);

      return { ok: true, sandboxId: acquired.value.id, created: acquired.value.created };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger().error({ err: error }, "could not resume the project");
      return { ok: false, reason: "internal", message };
    }
  }

  /**
   * Picking a job back up where a process restart left it.
   *
   * The log is the only state there is, so this folds it and acts on what `continue-job.ts`
   * makes of the result — no supervisor, no scan, no jobs index. Three of its four answers cost
   * nothing: an unfinished job with no commit behind it is closed, a job already sitting at a
   * checkpoint is closed, and a session with nothing open does nothing at all.
   *
   * **A throw here never fails the resume, and never leaves the job open.** The project is up
   * either way, and reporting the open as broken because a continuation fell over would take the
   * app away from somebody over work they can restart with a sentence. Closing the job is the
   * other half: left open, it is one that every subsequent open would try to continue again.
   */
  async #continue(scope: TurnScope, sandboxId: string, options: ContinueOptions): Promise<void> {
    const { session, sink } = scope;
    const history = await this.#options.events.readFrom(session.sessionId, 0);
    const continuation = continuationFor(foldJobs(history));

    if (continuation.kind === "none") return;

    if (continuation.kind === "close") {
      scope.emit("job.completed", {
        jobId: continuation.jobId,
        outcome: continuation.outcome,
      });
      await sink.drain();
      getLogger().info(
        { jobId: continuation.jobId, outcome: continuation.outcome },
        "an open job had nothing left to do and was closed",
      );
      return;
    }

    const run: JobRun = {
      settings: { sessionId: session.sessionId, ...options },
      session,
      sink,
      sandboxId,
      jobId: continuation.jobId,
      objective: continuation.objective,
      attempts: [...continuation.attempts],
      // Where the budget stopped, not where it starts. Resetting it is how a project that
      // restarts under a check it cannot pass repairs forever.
      repairs: continuation.attemptsUsed,
      turn: scope,
      open: true,
    };

    getLogger().info(
      { jobId: run.jobId, kind: continuation.kind, repairs: run.repairs },
      "continuing an open job",
    );

    // The commit the job left behind, arbitrated as the claim its turn would have made. Nothing
    // is preserved or photographed off it: it reached storage before the process died, which is
    // how it is here to be checked at all.
    const outcome: TurnOutcome = {
      ok: true,
      turnId: scope.turnId,
      commitSha: continuation.kind === "verify" ? continuation.commitSha : null,
    };

    try {
      await this.#driveJob(run, {
        outcome,
        failed: continuation.kind === "repair" ? continuation.failed : null,
        announce: continuation.kind === "verify" ? continuation.announce : true,
        fresh: false,
      });
    } catch (error) {
      getLogger().error({ err: error, jobId: run.jobId }, "could not continue the open job");

      // The same reasoning the turn path's catch uses, for the same reason: a job left open by a
      // continuation that fell over is one that the *next* open would try to continue too, and
      // nothing about the failure has changed by then.
      if (run.open) {
        run.turn.emit("job.completed", { jobId: run.jobId, outcome: "abandoned" });
        await sink.drain().catch(() => {});
      }
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

    const { session, sink } = scope;

    /**
     * The job, once one is open — held here so the catch below can write under the turn that is
     * actually running and close a job that a throw left open. Both move on with each repair,
     * and a throw can land between one turn ending and the next beginning.
     */
    let run: JobRun | null = null;

    const emit = <T extends NapEvent["type"]>(type: T, payload: Payload<T>): void => {
      (run?.turn ?? scope).emit(type, payload);
    };

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

      // A job opens on a prompt, and this turn belongs to it. Opened after the sandbox is in
      // hand because a job that could never run is a job nothing will ever close — and the
      // objective repeats the message on purpose, so the log answers "what was asked" without
      // a reader having to work out which message belongs to which job.
      const jobId = crypto.randomUUID();
      const objective = objectiveOf(request.message);
      emit("job.started", { jobId, objective });

      // Before the preview, which is about to show whatever state the notice is explaining.
      for (const notice of sandboxId.value.notices) emit("system.notice", notice);

      // Only for a sandbox this turn created. A resumed one is already serving and announced
      // itself on the turn that made it — the client replays that. Re-announcing would reload
      // the app underneath someone in the middle of using it, on every turn.
      if (sandboxId.value.created) await this.#announcePreview(sandboxId.value.id, emit);

      run = {
        settings: request,
        session,
        sink,
        sandboxId: sandboxId.value.id,
        jobId,
        objective,
        attempts: [],
        repairs: 0,
        turn: scope,
        open: true,
      };

      const outcome = await this.#attempt({
        settings: request,
        scope,
        sandboxId: run.sandboxId,
        prompt: request.message,
        promptSource: "user",
        commitSubject: request.message,
        history,
        job: { objective, attempts: [] },
      });

      return await this.#driveJob(run, { outcome, failed: null, announce: true, fresh: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Only if the turn is not already closed — a thrown error after a `turn.failed` would
      // otherwise close the same turn twice.
      if (sink.terminal === null) emit("turn.failed", { reason: "internal", message });

      // The job goes with it, whether or not the turn that crashed had already ended: a job left
      // open is one the next opening of this project would continue, spending tokens on the
      // aftermath of a crash. Tracked rather than inferred from the turn, because the throw can
      // land between a turn ending and the next one starting.
      if (run?.open === true) emit("job.completed", { jobId: run.jobId, outcome: "abandoned" });

      // Best effort: if persistence is what broke, there is nowhere left to record it.
      await sink.drain().catch(() => {});

      return { ok: false, turnId: (run?.turn ?? scope).turnId, reason: "internal", message };
    }
  }

  /**
   * The job, turn by turn, until something ends it.
   *
   * Every iteration arbitrates one completed turn and then decides whether there is another to
   * run. This loop is the whole of the repair machinery: a repair turn needs no new lifecycle
   * because it is the same one, run again with a different prompt.
   *
   * **It is also where a continued job rejoins.** A job left open by a process restart is the
   * same job with some of its budget spent, so opening the project hands this the state the log
   * folded to and lets it carry on (`continue-job.ts`). The entry says which of the loop's two
   * halves to start in: a commit nothing has checked enters at the arbitration, and a failure
   * the log already recorded enters at the repair it prompts.
   */
  async #driveJob(run: JobRun, entry: JobEntry): Promise<TurnOutcome> {
    const { session, sink, sandboxId, jobId, objective, settings, attempts } = run;
    const emit = <T extends NapEvent["type"]>(type: T, payload: Payload<T>): void => {
      run.turn.emit(type, payload);
    };
    /** Written once, wherever the loop leaves. */
    const close = async (outcome: JobOutcome): Promise<void> => {
      emit("job.completed", { jobId, outcome });
      run.open = false;
      await sink.drain();
    };

    let { outcome, failed, announce, fresh } = entry;

    for (;;) {
      if (failed === null) {
        if (!outcome.ok) {
          // The turn the job was riding on refused, was cancelled, or fell over. Nothing will
          // pick the job back up — that turn changed nothing, and a repair repairs a workspace
          // that was changed.
          await close("abandoned");
          return outcome;
        }

        // Before the snapshot and the photograph: this is what the person watching is waiting
        // for, and the two below are housekeeping nobody is looking at.
        failed = await this.#arbitrate({
          scope: run.turn,
          jobId,
          sandboxId,
          commitSha: outcome.commitSha,
          announce,
        });
        // Every round after the first is one this loop began itself.
        announce = true;

        // Only for a turn this loop ran. A continued job is arbitrating a commit that reached
        // storage before the process died, and re-bundling it would pay for the same bytes
        // twice — and photograph an application nothing has changed since the last shot.
        if (fresh) {
          await this.#preserve(session.projectId, sandboxId, outcome.commitSha);
          // After the snapshot, deliberately: the work reaching storage is what must not be
          // delayed by a browser launch, and a picture is the one thing here nobody would miss.
          // Only when the turn changed something — an unchanged app photographs identically.
          if (outcome.commitSha !== null) await this.#photograph(session.projectId, sandboxId);
        }

        // Arbitration closed the job: it passed, there was nothing to check, or the run learned
        // nothing about the project.
        if (failed === null) {
          run.open = false;
          return outcome;
        }
      }

      if (run.repairs >= MAX_REPAIR_ATTEMPTS) {
        // Nothing is reverted. The code stays committed and `HEAD` stays diverged from the
        // last checkpoint, because a user can frequently close the gap with one sentence and
        // throwing the work away to tidy an invariant is the worse trade (docs/adr/0006).
        await close("exhausted");
        getLogger().warn(
          { check: failed.name, repairs: run.repairs },
          "the repair attempts are spent and the checks are still red",
        );
        return outcome;
      }

      // Cancellation stops the loop, not just the turn. The signal is checked here as well as
      // inside the agent because this is the one moment where nothing is running: a cancel
      // that landed while the checks were running would otherwise start another turn on it.
      if (settings.signal?.aborted === true) {
        await close("abandoned");
        getLogger().info({ check: failed.name }, "the job was cancelled before its repair");
        return outcome;
      }

      // Recorded before the repair runs, so the turn that is about to try again is told what
      // the checks have said every time so far — including this time.
      attempts.push({ check: failed.name, detail: failed.detail, output: failed.output });

      run.repairs += 1;
      const attempt = run.repairs;
      const repairTurnId = this.#newTurnId();
      run.turn = this.#scopeFor(session, sink, settings.sessionId, repairTurnId);
      const repaired = failed;
      outcome = await withLogContext(getLogger(), { turnId: repairTurnId }, () =>
        this.#repair({
          settings,
          scope: run.turn,
          sandboxId,
          failed: repaired,
          attempt,
          job: { objective, attempts: [...attempts] },
        }),
      );
      failed = null;
      fresh = true;
    }
  }

  /**
   * One turn of a job: build its context, run the agent, and say how it ended.
   *
   * Everything that differs between the user's turn and a repair is a parameter here — the
   * prompt, where it came from, what its commit is called — and nothing else does. That is the
   * whole of ADR-0006's "a repair is a Turn": budgets, cancellation, event ordering, streaming
   * and commit-on-completion are not re-implemented for repairs because they are not reached
   * twice.
   *
   * Reports rather than throws, including when the agent ends a turn without ending it. The
   * caller decides what a failure means for the job.
   */
  async #attempt(options: {
    settings: TurnSettings;
    scope: TurnScope;
    sandboxId: string;
    /** What the model is being asked, which the context engine appends itself. */
    prompt: string;
    promptSource: PromptSource;
    /** The subject for whatever this turn commits. */
    commitSubject: string;
    /** The session's events, read *before* this turn's prompt was logged. */
    history: StoredEvent[];
    /**
     * What the job is for and what its checks have said, for the prompt.
     *
     * Handed to the context engine rather than folded there: the component that owns the token
     * budget performs no I/O and does not read the log twice.
     */
    job: JobContext;
  }): Promise<TurnOutcome> {
    const { settings, scope, sandboxId, prompt, promptSource, commitSubject, history, job } =
      options;
    const { sink, emit, turnId } = scope;

    const context = await this.#options.context.build({
      sessionId: settings.sessionId,
      sandboxId,
      userMessage: prompt,
      history,
      job,
      sandbox: this.#options.sandbox,
      memory: this.#options.memory,
    });

    // The previous turn of this job ended on this sink, and its ending is not this one's.
    sink.beginTurn();

    await this.#options.agent.runTurn({
      sessionId: settings.sessionId,
      turnId,
      sandboxId,
      context,
      sandbox: this.#options.sandbox,
      onEvent: sink.emit,
      promptSource,
      finalize: () => this.#commit(sandboxId, commitSubject),
      ...(settings.signal === undefined ? {} : { signal: settings.signal }),
      ...(settings.model === undefined ? {} : { model: settings.model }),
      // Passed straight through and read nowhere here: the runtime decides *when* a turn
      // runs, never who pays for it.
      ...(settings.credentials === undefined ? {} : { credentials: settings.credentials }),
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
  }

  /**
   * The turn a failed check prompts.
   *
   * The prompt is written down as a `user.message` like any other, and *that is deliberate*: it
   * is what the model was asked, the transcript is the record of what was asked, and a second
   * event type for it would leave every replay, every context build and every chat pane with two
   * shapes to handle. What distinguishes it is `turn.started`'s source, which is one field on an
   * event the log already carries.
   */
  async #repair(options: {
    settings: TurnSettings;
    scope: TurnScope;
    sandboxId: string;
    failed: CheckFailure;
    attempt: number;
    job: JobContext;
  }): Promise<TurnOutcome> {
    const { settings, scope, sandboxId, failed, attempt, job } = options;
    const prompt = repairPrompt({ failed, attempt });

    getLogger().info({ check: failed.name, attempt }, "repairing a failed check");

    // Read before the prompt is logged, for the same reason the user's turn does it: the
    // context engine appends this turn's own message itself.
    const history = await this.#options.events.readFrom(settings.sessionId, 0);
    scope.emit("user.message", { text: prompt });

    return await this.#attempt({
      settings,
      scope,
      sandboxId,
      prompt,
      promptSource: "verification",
      commitSubject: repairCommitSubject(failed, attempt),
      history,
      job,
    });
  }

  /**
   * Arbitrating the model's claim: the turn says it is done, and this asks the project.
   *
   * **A turn that mutated nothing is not verified at all.** No commit means no claim about the
   * code — somebody asked a question and got an answer — and running a project's whole test
   * suite against a workspace nobody touched spends a minute to learn what the last
   * verification already said. The job closes *unverified*, which is neither a pass nor a
   * failure and has its own word for exactly that reason.
   *
   * **Only a passing verification checkpoints.** The commit happens either way, as it did in
   * v1; a checkpoint is the sha verification agreed with, and keeping the two apart is what
   * makes a red run unable to corrupt the last known-good state by construction (ADR-0006).
   *
   * **An errored run is not a verification and is never written as one.** `foldJobs` reads an
   * all-absent payload as *verified*, so recording a run that learned nothing would checkpoint
   * a commit against which nothing ran. The job ends *abandoned* instead — the sandbox went
   * away, and a repair turn on that asks a model to fix a machine it cannot see.
   *
   * **A composition that was asked to `trust` never gets here at all**, in the sense that it
   * returns on the first branch below: the job closes unverified, exactly as v1's turns ended.
   * See `verification` on the options for why that switch exists.
   *
   * **A red verification leaves the job open**, at `repairing`, and is the one path that writes
   * no `job.completed`: it returns the check that said no, for the caller to prompt a repair
   * turn with. Nothing here reverts — the broken code stays committed, because the attempt that
   * fixes it needs to be able to read it.
   */
  async #arbitrate(options: {
    scope: TurnScope;
    jobId: string;
    sandboxId: string;
    commitSha: string | null;
    /**
     * Whether this round is new.
     *
     * False when a restart is finishing a `verification.started` that is already in the log:
     * `foldJobs` counts repair attempts from those, so writing a second one for the same round
     * would spend an attempt that no repair turn ever used (`continue-job.ts`).
     */
    announce: boolean;
  }): Promise<CheckFailure | null> {
    const { scope, jobId, sandboxId, commitSha, announce } = options;
    const { sink, emit } = scope;

    // Nothing to arbitrate against, either because the turn made no claim about the code or
    // because this composition was asked not to arbitrate at all. Both close the job
    // *unverified*, which is the word for a job whose code no check ever looked at.
    if (commitSha === null || this.#options.verification === "trust") {
      emit("job.completed", { jobId, outcome: "unverified" });
      await sink.drain();
      return null;
    }

    // Drained before the checks run, not after: this event exists so that "the checks are
    // running right now" is a fact in the log rather than a gap between two others, and a
    // client cannot render a gap.
    if (announce) emit("verification.started", { jobId });
    await sink.drain();

    const verified = await this.#runChecks(sandboxId);

    if (verified === null || verified.verdict === "errored") {
      emit("job.completed", { jobId, outcome: "abandoned" });
      await sink.drain();
      getLogger().warn({ commitSha }, "verification learned nothing about the project");
      return null;
    }

    emit("verification.completed", { jobId, checks: toVerifiedChecks(verified.checks) });

    if (verified.verdict === "passed") {
      emit("job.checkpointed", { jobId, commitSha });
      emit("job.completed", { jobId, outcome: "verified" });
      await sink.drain();
      getLogger().info({ commitSha }, "turn checkpointed");
      return null;
    }

    const failed = verified.checks.find((check) => check.outcome === "failed");

    // A `failed` verdict *is* a check that said no, so this branch is unreachable — but a job
    // left open with nothing to repair is one that the next opening of the project would try to
    // continue forever, so the disagreement is closed rather than trusted not to happen.
    if (failed === undefined) {
      emit("job.completed", { jobId, outcome: "abandoned" });
      await sink.drain();
      getLogger().warn({ commitSha }, "verification failed without naming a failing check");
      return null;
    }

    await sink.drain();
    getLogger().info({ commitSha, check: failed.name }, "verification failed; the job stays open");
    return failureOf(failed);
  }

  /**
   * The checks, with a thrown error treated the same as a sandbox that would not answer.
   *
   * Nothing below is supposed to throw — `@nap/verify` returns its failures — but the turn is
   * already complete and committed by the time any of it runs, and turning a finished turn into
   * a failed one because a probe blew up would report the wrong thing to the person waiting.
   */
  async #runChecks(sandboxId: string): Promise<VerificationResult | null> {
    try {
      return await verifyTurn({
        sandbox: this.#options.sandbox,
        sandboxId,
        previewPort: this.#previewPort,
        previewTimeoutMs: this.#previewTimeoutMs,
      });
    } catch (error) {
      getLogger().warn({ err: error }, "the checks could not be run");
      return null;
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
 * What the job records as having been asked.
 *
 * The message, whole — a job's objective is the request rather than a summary of it, and the
 * repair prompt that reads it back needs the detail. The fallback is for a caller below the
 * HTTP route, which is the only way an empty message reaches here: the event contract requires
 * an objective, and refusing to open a job would be a turn nothing could ever close.
 */
function objectiveOf(message: string): string {
  const objective = message.trim();
  return objective === "" ? "an unstated objective" : objective;
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
