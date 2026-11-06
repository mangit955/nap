import { VERIFICATION_ROUND_LIMIT_MS } from "@nap/shared/command-windows";
import type { QueueLeaseIdentity } from "@nap/shared/ports/project-computer-access";
import type { ProjectComputer } from "./project-computer.ts";
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

import { commitAll, currentSha } from "@nap/sandbox/git";
import { TEMPLATE_DEV_PORT, TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import type { ProposedPlan } from "@nap/shared/agent-plan";
import { appTestTarget } from "@nap/shared/app-testing";
import type { JobOutcome, NapEvent, NapEventOf, PromptSource } from "@nap/shared/events";
import { foldJobs, MAX_REPAIR_ATTEMPTS, openJob } from "@nap/shared/job-state";
import { addLogContext, getLogger, withLogContext } from "@nap/shared/logging";
import { modelSupportsImages } from "@nap/shared/model-capabilities";
import { approvedPlanOfJob, pendingPlan } from "@nap/shared/plan-mode";
import type { AgentService, AgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { ContextEngine, FailedAttempt, JobContext } from "@nap/shared/ports/context-engine";
import type { EventBus } from "@nap/shared/ports/event-bus";
import type { EventStore, PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import type { ModelCredentials } from "@nap/shared/ports/llm-provider";
import type { MemoryProvider } from "@nap/shared/ports/memory-provider";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { RepositorySource, RepositoryWorkspace } from "@nap/shared/ports/repository-workspace";
import type {
  ContinueOptions,
  ResumeOutcome,
  Runtime,
  TurnOutcome,
  TurnRequest,
} from "@nap/shared/ports/runtime";
import type { SandboxCapacity } from "@nap/shared/ports/sandbox-capacity";
import type { SandboxError, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SandboxRecordings } from "@nap/shared/ports/sandbox-recordings";
import type { SessionRecord, SessionStore } from "@nap/shared/ports/session-store";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
import type { RequestSteering, Steer } from "@nap/shared/ports/steer-queue";
import type { Result } from "@nap/shared/result";
import { shellQuote } from "@nap/shared/shell";
import { TurnAbortError } from "@nap/shared/turn-abort";
import type { VerificationResult } from "@nap/verify/run-checks";
import {
  type AcquiredSandbox,
  acquireSandbox,
  type RestoreDeps,
  restoreDepsOf,
} from "./acquire-sandbox.ts";
import { type AppTestRecordingClock, withAppTestRecording } from "./app-test-recording.ts";
import { AppTestRun } from "./app-test-run.ts";
import { contextCompactor } from "./compaction.ts";
import { compactionHistoryFile } from "./compaction-history.ts";
import { continuationFor } from "./continue-job.ts";
import { EventSink } from "./event-sink.ts";
import { shouldAnnouncePreview } from "./preview-announced.ts";
import { repairCommitSubject, repairPrompt } from "./repair-prompt.ts";
import { SessionHistory } from "./session-history.ts";
import { SessionQueue } from "./session-queue.ts";
import { captureSnapshot } from "./teardown.ts";
import { testPrompt } from "./test-prompt.ts";
import type { ThumbnailLane } from "./thumbnail-lane.ts";
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
  sandboxStopped?: boolean;
  session: SessionRecord;
  sink: EventSink;
  /**
   * The log as this runtime call has read it. Shared by every turn of the job, like the sink,
   * so a repair tops up what the prompt's turn read instead of reading the session again.
   */
  history: SessionHistory;
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
  lease?: QueueLeaseIdentity | undefined;
  /** The request's steering, read by every turn it runs; see `TurnRequest`. */
  steering?: RequestSteering | undefined;
  work?: { stopped: boolean };
  sessionId: string;
  signal?: AbortSignal | undefined;
  model?: string | undefined;
  credentials?: ModelCredentials | undefined;
  workspace?: "repository";
};

/**
 * A job in flight, and what it is doing right now.
 *
 * Mutable, and held by whoever started it: the loop moves `turn` on with each repair and clears
 * `open` when it writes the `job.completed`, and the caller's catch has to be able to read both
 * — a throw can land between one turn ending and the next beginning.
 */
type JobRun = {
  /** The request stays fixed while turn advances through verification repairs. */
  requestId: string;
  settings: TurnSettings;
  session: SessionRecord;
  sink: EventSink;
  sandboxId: string;
  jobId: string;
  objective: string;
  /** The approved plan this job carries out, for every turn of it (ADR-0025). */
  plan?: ProposedPlan | undefined;
  /** Failures already responded to, oldest first — the one thing a repair cannot rederive. */
  attempts: FailedAttempt[];
  /** Repair turns already spent. Non-zero for a job a restart is continuing. */
  repairs: number;
  /** The turn the job is running right now. */
  turn: TurnScope;
  /** False once a `job.completed` has been written for it. */
  open: boolean;
  previewPort: number | null;
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

/**
 * Why an approval built nothing: the plan it names had already been approved, revised or set
 * aside by the time its turn ran. Said plainly, because the person approved something and is owed
 * a reason nothing happened.
 */
const STALE_APPROVAL =
  "That plan was no longer waiting for approval, so nothing was built. Approve the latest plan, or say what to build.";

/** Git's own convention for a subject line, and what every log viewer is laid out for. */
const COMMIT_SUBJECT_LIMIT = 72;

/**
 * How long a newly created sandbox's dev server has to answer before it goes unannounced. The
 * turn does not wait on it (see `#startPreviewAnnouncement`), but the turn's ending does, so this
 * bounds how long a turn that finishes first can be held. The template serves in about two
 * seconds from cold.
 */
const PREVIEW_TIMEOUT_MS = 20_000;

/**
 * How long a sandbox found already running, whose preview the log never announced, has to answer.
 *
 * Short, because it is asked again on every call. Such a sandbox is one whose dev server missed its
 * creating call's wait — usually because it never answers at `/` at all (a 404 there, an API-only
 * server, a crash), and an imported repository makes that common. A full wait would then hold the
 * ending of every short turn, `/compact` and plan proposal for it, and the lease with it, so a
 * queued message would wait too. A server that has been up for a while answers the first probe in
 * well under a second; this is about one of the provider adapter's own probe windows. What it
 * gives up is a server still coming up — a create cancelled moments ago, still reinstalling — and
 * the next call asks again.
 */
const PREVIEW_RECHECK_MS = 5_000;

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

/** Somebody asked for this, so it is neither a warning nor an invitation to try again. */
const RESUME_CANCELLED_NOTICE =
  "Stopped starting this project back up. Nothing has been lost — its files are still saved.";

export type SingleAgentRuntimeOptions = {
  sessions: SessionStore;
  sandbox: SandboxManager;
  context: ContextEngine;
  agent: AgentService;
  computer?: {
    coordinator: ProjectComputer;
    objects: ObjectStore;
    recordings?: SandboxRecordings;
  };
  events: EventStore;
  bus: EventBus;
  memory: MemoryProvider;
  repository?: RepositoryWorkspace;
  /**
   * Where a project's bytes and its snapshot rows live. Supply both to make a project
   * survive its sandbox; supply neither and a session without a live sandbox starts from
   * the bare template, which is all this could do before snapshots existed.
   */
  objects?: ObjectStore;
  snapshots?: SnapshotStore;
  /**
   * Where to ask for the picture of the project the dashboard puts on its card.
   *
   * Optional and independent of the pair above: a deployment with no browser to drive still
   * runs turns and still keeps the work — it just shows a colour where a screenshot would be.
   */
  thumbnails?: ThumbnailLane;
  /**
   * The ceiling on how many sandboxes exist at once, claimed at the moment one is created.
   *
   * **This is the authoritative one**, and the route's quota check is an advisory refusal in
   * front of it: a turn may wait before it runs, so capacity claimed at admission would be held
   * for work that has not started. Absent means uncapped — the harness and the benchmark, which
   * create one sandbox at a time and pay for it either way. Every deployment supplies one, and
   * `compose.test.ts` is what says so.
   */
  capacity?: SandboxCapacity;
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
  /**
   * Injected for the same reason: a turn id a test can predict.
   *
   * **Repairs only, and that is now literally true.** Both entry points take their turn id from
   * the caller — `TurnRequest.turnId` and `ContinueOptions.turnId` — so the only Turns this
   * runtime still names are the ones nobody asked for by name: a repair the verifier prompted.
   */
  newTurnId?: () => string;
  /** The port the project's dev server listens on. Defaults to the template's. */
  previewPort?: number;
  /** How long a sandbox this call created has to start serving before it goes unannounced. */
  previewTimeoutMs?: number;
  /** How long one found running, but never announced, gets instead. See `PREVIEW_RECHECK_MS`. */
  previewRecheckMs?: number;
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
  readonly #previewRecheckMs: number;
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
    this.#previewRecheckMs = options.previewRecheckMs ?? PREVIEW_RECHECK_MS;
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
  resumeSession(sessionId: string, options: ContinueOptions): Promise<ResumeOutcome> {
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
    const { turnId } = request;
    return await withLogContext(getLogger(), { sessionId: request.sessionId, turnId }, () =>
      request.kind === "test" ? this.#runAppTest(request) : this.#runTurnLogged(request, turnId),
    );
  }

  /** The same log context a turn gets, around a lifecycle operation that has no turn id. */
  async #resume(sessionId: string, options: ContinueOptions): Promise<ResumeOutcome> {
    const { turnId } = options;
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
    const history = new SessionHistory(this.#options.events, sessionId);

    return this.#scopeFor(session, sink, history, sessionId, turnId);
  }

  /** The same session, sink and history, under a different turn — what a repair runs in. */
  #scopeFor(
    session: SessionRecord,
    sink: EventSink,
    history: SessionHistory,
    sessionId: string,
    turnId: string,
  ): TurnScope {
    const emit = <T extends NapEvent["type"]>(type: T, payload: Payload<T>): void => {
      sink.emit({ type, payload, sessionId, turnId, createdAt: this.#now() } as PendingEvent);
    };

    return { session, sink, history, turnId, emit };
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
      const acquired = await this.#acquire(session, options.signal);

      if (!acquired.ok) {
        // A notice, not a `turn.failed`. No turn ran, so a failed one would put a retry button
        // under a conversation that never happened — and the preview pane reads a sandbox
        // failure as the state of the *last turn*, which nothing here is.
        const cancelled = options.signal?.aborted === true;
        emit(
          "system.notice",
          cancelled
            ? { level: "info", text: RESUME_CANCELLED_NOTICE }
            : { level: "warning", text: resumeFailureNotice(acquired.error) },
        );
        await sink.drain();
        getLogger().warn(
          { reason: acquired.error.code, cancelled },
          "could not resume the project",
        );
        return { ok: false, reason: "sandbox_unavailable", message: acquired.error.message };
      }

      for (const notice of acquired.value.notices) emit("system.notice", notice);

      // Only for a sandbox the log has not announced (`preview-announced.ts`). One that was
      // already serving has its `preview.ready` in the log already, and re-announcing remounts
      // the frame underneath whoever is using the app.
      const previewPort =
        acquired.value.repository === undefined
          ? this.#previewPort
          : acquired.value.repository.previewPort;
      this.#startPreviewAnnouncement(scope, {
        acquired: acquired.value,
        history: await scope.history.read(),
        port: previewPort,
        signal: options.signal,
      });

      await sink.drain();
      getLogger().info({ created: acquired.value.created }, "project resumed");

      // A project that has just come back up is serving again, and its card may be showing
      // nothing at all — every project made before there was a browser to photograph one has
      // no picture, and a turn is the only other thing that would take it. Only for a sandbox
      // this created: one that was already serving has not changed since whatever last
      // photographed it.
      //
      // Only asked for here, because the lease is held until the continuation below is done and
      // a browser launch must not be able to delay that, or the resume, or the next message.
      //
      // With the runtime's own preview deadline rather than the lane's shorter one: nothing above
      // waited for the dev server, so it may still be coming up, and a picture the announcement
      // would still have got is one this should get too.
      if (acquired.value.created && previewPort !== null)
        await this.#photograph(session.projectId, acquired.value.id, previewPort, {
          previewTimeoutMs: this.#previewTimeoutMs,
        });

      // Last of all, and after everything the caller asked for is done: continuing a job runs
      // turns, which take minutes, and the project is up and usable the whole time. The caller
      // does not wait on this — `POST /projects/:id/open` has already answered — but the queue
      // does, which is what stops a message sent during a continuation interleaving with it.
      await this.#continue(scope, acquired.value.id, options, acquired.value.repository);

      return { ok: true, sandboxId: acquired.value.id, created: acquired.value.created };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger().error({ err: error }, "could not resume the project");
      return { ok: false, reason: "internal", message };
    } finally {
      // Nothing this call promised may be written after it returns: the lease goes with it.
      await sink.settle().catch(() => {});
    }
  }

  /**
   * Picking a job back up where a process restart left it.
   *
   * The log is where the state is kept, so this folds it and acts on what `continue-job.ts`
   * makes of the result — no supervisor, no scan, no jobs index. Three of its four answers cost
   * nothing: an unfinished job with no commit behind it is closed, a job already sitting at a
   * checkpoint is closed, and a session with nothing open does nothing at all.
   *
   * **The restored workspace's HEAD goes in alongside it.** A turn commits before it announces
   * the commit, so a log that stops in that gap describes a project that committed nothing while
   * the sandbox holds the commit. Reading HEAD here is what stops that work being closed out
   * unverified and left there.
   *
   * **A throw here never fails the resume, and never leaves the job open.** The project is up
   * either way, and reporting the open as broken because a continuation fell over would take the
   * app away from somebody over work they can restart with a sentence. Closing the job is the
   * other half: left open, it is one that every subsequent open would try to continue again.
   */
  async #continue(
    scope: TurnScope,
    sandboxId: string,
    options: ContinueOptions,
    repository?: RepositorySource,
  ): Promise<void> {
    const { session, sink } = scope;
    const history = await scope.history.read();
    const state = foldJobs(history);

    // Asked before HEAD is read, because reading it is a round trip into the sandbox and most
    // opens have nothing open to continue. `continuationFor` answers `none` for these anyway —
    // this only decides whether the evidence is worth fetching.
    if (openJob(state) === undefined) return;

    const continuation = continuationFor(state, {
      workspaceHeadSha: await this.#workspaceHead(sandboxId),
    });

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
      await this.#finishRepositoryJob({
        scope,
        sandboxId,
        jobId: continuation.jobId,
        requestId: options.turnId,
        signal: options.signal,
      });
      return;
    }

    // The resume owns this continuation's lease, but each repair gets a separate turn id.
    const { turnId: _resumeTurnId, ...inherited } = options;

    const run: JobRun = {
      requestId: options.turnId,
      settings: {
        sessionId: session.sessionId,
        ...inherited,
        ...(repository === undefined ? {} : { workspace: "repository" }),
      },
      session,
      sink,
      sandboxId,
      jobId: continuation.jobId,
      objective: continuation.objective,
      plan: approvedPlanOfJob(history, continuation.jobId),
      attempts: [...continuation.attempts],
      // Where the budget stopped, not where it starts. Resetting it is how a project that
      // restarts under a check it cannot pass repairs forever.
      repairs: continuation.attemptsUsed,
      turn: scope,
      open: true,
      previewPort: repository === undefined ? this.#previewPort : repository.previewPort,
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
      await this.#prepareRepositoryJob(run);
      await this.#driveJob(run, {
        outcome,
        failed: continuation.kind === "repair" ? continuation.failed : null,
        announce: continuation.kind === "verify" ? continuation.announce : true,
        fresh: false,
      });
    } catch (error) {
      getLogger().error({ err: error, jobId: run.jobId }, "could not continue the open job");

      // A resume itself has no turn, but a durable repair prompt does. Context preparation
      // can throw before the agent emits a start or terminal for that child. Drained first,
      // best effort: an ending the sink is holding for the preview is not yet `terminal`, and
      // reading it early would close the same turn twice.
      await sink.drain().catch(() => {});
      if (run.turn !== scope && sink.terminal === null) {
        run.turn.emit("turn.failed", {
          reason: options.signal?.aborted === true ? "cancelled" : "internal",
          message: error instanceof Error ? error.message : String(error),
        });
      }

      // The same reasoning the turn path's catch uses, for the same reason: a job left open by a
      // continuation that fell over is one that the *next* open would try to continue too, and
      // nothing about the failure has changed by then.
      if (run.open) {
        run.turn.emit("job.completed", { jobId: run.jobId, outcome: "abandoned" });
        await sink.drain().catch(() => {});
        await this.#finishRepositoryJob({
          scope: run.turn,
          sandboxId,
          jobId: run.jobId,
          requestId: run.requestId,
          signal: options.signal,
        });
      }
    }
  }

  /**
   * What the restored project is actually sitting on, for the continuation to weigh against
   * what its log remembers.
   *
   * Read here rather than inside `continue-job.ts` so that decision stays a pure function of its
   * inputs. A failure is not one: a repository with no commits and a sandbox that will not answer
   * both mean "nothing to say", and the log is then the whole of the evidence.
   */
  async #workspaceHead(sandboxId: string): Promise<string | null> {
    const head = await currentSha(this.#options.sandbox, sandboxId);
    // An empty answer is no answer. `currentSha` trims, and a blank sha passed on as evidence
    // would beat the log's own `headSha` with nothing at all.
    if (head.ok) return head.value === "" ? null : head.value;

    getLogger().warn(
      { reason: head.error.code },
      "could not read the workspace HEAD; continuing on the log alone",
    );
    return null;
  }

  async #runAppTest(request: Extract<TurnRequest, { kind: "test" }>): Promise<TurnOutcome> {
    const { turnId, sessionId } = request;
    const scope = await this.#open(sessionId, turnId);
    if (!scope) return { ok: false, turnId, reason: "internal", message: "No such session." };
    const { emit, sink } = scope;
    let run: AppTestRun | undefined;
    try {
      if (!this.#options.computer || !modelSupportsImages(request.model))
        throw new Error("App tests need an available computer and an image-capable model.");
      request.signal?.throwIfAborted();
      const history = await scope.history.read();
      const target = appTestTarget(history);
      if (!target || target.jobId !== request.jobId)
        throw new Error("The approved job is no longer the latest completed checkpoint.");
      const acquired = await this.#acquire(scope.session, request.signal);
      if (!acquired.ok) throw new Error(acquired.error.message);
      const sandboxId = acquired.value.id;
      const head = await currentSha(this.#options.sandbox, sandboxId);
      if (!head.ok || head.value !== target.commitSha)
        throw new Error(
          "The app changed after this job completed. Complete a new job before testing it.",
        );
      const clean = await this.#options.sandbox.exec(
        sandboxId,
        `cd ${shellQuote(TEMPLATE_WORKDIR)} && git status --porcelain`,
      );
      if (!clean.ok || clean.value.exitCode !== 0 || clean.value.stdout.trim())
        throw new Error(
          "The app has uncommitted source changes. Complete a new job before testing it.",
        );
      const diff = await this.#options.sandbox.exec(
        sandboxId,
        `cd ${shellQuote(TEMPLATE_WORKDIR)} && git diff --no-ext-diff --no-textconv ${shellQuote(target.baseRevision)} ${shellQuote(target.commitSha)} --`,
      );
      if (!diff.ok || diff.value.exitCode !== 0)
        throw new Error("Could not read this job's source diff.");
      request.signal?.throwIfAborted();
      const prompt = testPrompt({ objective: target.objective, diff: diff.value.stdout });
      const ledger = new AppTestRun({
        now: () => Date.parse(this.#now()),
        emit: (entry) => emit("test.annotation", entry),
      });
      run = ledger;
      const previewPort =
        acquired.value.repository === undefined
          ? this.#previewPort
          : acquired.value.repository.previewPort;
      if (previewPort === null) throw new Error("App tests need a running project preview.");
      // The generated diff prompt stays ephemeral; the durable goal and source commit reserve
      // the recording identity before any capture or upload can occur.
      const outcome = await withAppTestRecording(
        {
          projectId: scope.session.projectId,
          sessionId,
          turnId,
          sandboxId,
          devServerUrl: `http://localhost:${previewPort}`,
          started: {
            jobId: target.jobId,
            commitSha: target.commitSha,
            objective: target.objective,
          },
          desktop: this.#options.computer.coordinator.desktop,
          recordings: this.#options.computer.recordings,
          objects: this.#options.computer.objects,
          ...(request.signal ? { signal: request.signal } : {}),
          emit,
          beforeCapture: async () => {
            await sink.drain();
            for (const notice of acquired.value.notices) emit("system.notice", notice);
            // Waited for here, unlike on every other path: the recording is of the running app,
            // and it starts the moment this returns.
            this.#startPreviewAnnouncement(scope, {
              acquired: acquired.value,
              history,
              port: previewPort,
              signal: request.signal,
              recording: true,
            });
            await sink.settle();
          },
        },
        async (clock) => {
          return this.#attempt({
            settings: {
              ...request,
              ...(acquired.value.repository ? { workspace: "repository" as const } : {}),
            },
            scope,
            sandboxId,
            prompt,
            promptSource: "test",
            commitSubject: "",
            history,
            appTest: { run: ledger, ...(clock ? { clock } : {}) },
            previewPort,
          });
        },
      );
      emit("test.completed", {
        jobId: target.jobId,
        status: outcome.ok ? "completed" : "interrupted",
        counts: run.counts(),
      });
      await sink.drain();
      return outcome;
    } catch (error) {
      const reason = request.signal?.aborted ? "cancelled" : "internal";
      const message =
        reason === "cancelled"
          ? "The app test was cancelled."
          : error instanceof Error
            ? error.message
            : "The app test could not start.";
      // Drained first for the reason the turn path's catch is: a held ending is not yet `terminal`.
      await sink.drain().catch(() => {});
      if (!sink.terminal) emit("turn.failed", { reason, message });
      if (run)
        emit("test.completed", {
          jobId: request.jobId,
          status: "interrupted",
          counts: run.counts(),
        });
      await sink.drain();
      return { ok: false, turnId, reason, message };
    } finally {
      await sink.settle().catch(() => {});
    }
  }

  async #runTurnLogged(
    request: Extract<TurnRequest, { message: string }>,
    turnId: string,
  ): Promise<TurnOutcome> {
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

    const outcome = await this.#runTurnInScope(request, turnId, scope);
    await this.#closeSteering(request, scope);
    return outcome;
  }

  /**
   * Ends steering for a request whose last turn is over (ADR-0027).
   *
   * After the job loop rather than after the person's turn, so a repair can still read what was
   * sent while the checks ran. Whatever nothing read becomes the next turn — unless the request was
   * stopped, in which case nothing more runs and each unread steer is handed back with an event
   * saying so. The queue decides that as well as this: a Stop already on the request's row drops
   * them even when the abort has not reached this process yet. A worker that has lost its lease
   * resolves nothing here, and the janitor answers for those steers once it reclaims the request.
   *
   * The reason names who ended it. Only a person's Stop is `stopped`; a drain that ran out of time
   * or a lease that went away is `interrupted`, as a dead worker is, because the pane tells the
   * person which of the two happened to their message.
   *
   * The dropped events are under the request's own turn id, as the received ones are, and after
   * that turn's terminal event. They open nothing: no reader of the log treats a steer as the start
   * of a turn.
   */
  async #closeSteering(
    request: Extract<TurnRequest, { message: string }>,
    scope: TurnScope,
  ): Promise<void> {
    if (request.steering === undefined) return;
    try {
      const closed = await request.steering.close(
        request.signal?.aborted === true ? "drop" : "defer",
      );
      const reason =
        request.signal?.reason instanceof TurnAbortError &&
        request.signal.reason.code !== "cancelled"
          ? "interrupted"
          : "stopped";
      for (const steer of closed.dropped)
        scope.emit("steer.dropped", { steerId: steer.id, text: steer.text, reason });
      if (closed.dropped.length > 0) await scope.sink.drain();
      if (closed.deferred.length > 0 || closed.dropped.length > 0)
        getLogger().info(
          { deferred: closed.deferred.length, dropped: closed.dropped.length },
          "steers the request never read were resolved",
        );
    } catch (error) {
      // The request still settles, and its turn's outcome stands. Steers left waiting on a settled
      // request are read by nothing; the pane offers each back once the session is idle.
      getLogger().warn({ err: error }, "could not close steering for a request");
    }
  }

  async #runTurnInScope(
    request: Extract<TurnRequest, { message: string }>,
    turnId: string,
    scope: TurnScope,
  ): Promise<TurnOutcome> {
    const { session, sink } = scope;

    /**
     * The job, once one is open — held here so the catch below can write under the turn that is
     * actually running and close a job that a throw left open. Both move on with each repair,
     * and a throw can land between one turn ending and the next beginning.
     */
    let run: JobRun | null = null;
    const manualCompactionId =
      request.message.trim() === "/compact" ? crypto.randomUUID() : undefined;
    let pendingCompaction = manualCompactionId;

    const emit = <T extends NapEvent["type"]>(type: T, payload: Payload<T>): void => {
      (run?.turn ?? scope).emit(type, payload);
    };

    getLogger().info({ chars: request.message.length }, "turn started");

    try {
      if (pendingCompaction !== undefined) {
        emit("compaction.started", { id: pendingCompaction, trigger: "manual" });
        await sink.drain();
      }
      // Read before the message is logged: the context engine appends the turn's own message
      // itself, so finding it in the history too would send it to the model twice.
      const history = await scope.history.read();

      if (manualCompactionId !== undefined) {
        request.signal?.throwIfAborted();
        if (request.attachments?.length) throw new Error("Send /compact without attachments.");
        if (
          !history.some((event) => event.type === "agent.message" || event.type === "tool.result")
        )
          throw new Error("There is no complete conversation to compact yet.");
        const acquired = await this.#acquire(session);
        if (!acquired.ok) throw new Error(acquired.error.message);
        const previewPort =
          acquired.value.repository === undefined
            ? this.#previewPort
            : acquired.value.repository.previewPort;
        for (const notice of acquired.value.notices) emit("system.notice", notice);
        this.#startPreviewAnnouncement(scope, {
          acquired: acquired.value,
          history,
          port: previewPort,
          signal: request.signal,
        });
        request.signal?.throwIfAborted();
        const outcome = await this.#attempt({
          settings: request,
          scope,
          sandboxId: acquired.value.id,
          previewPort,
          prompt: "",
          promptSource: "user",
          commitSubject: "",
          history,
          manualCompaction: {
            id: manualCompactionId,
            onSettled: () => {
              pendingCompaction = undefined;
            },
          },
        });
        if (!outcome.ok && pendingCompaction !== undefined) {
          emit("compaction.failed", {
            id: pendingCompaction,
            message: outcome.message,
            cancelled: outcome.reason === "cancelled",
            usage: null,
          });
          await sink.drain();
        }
        return outcome;
      }

      // **Before the sandbox, and durable before it.** Acquiring a workspace takes seconds on a
      // project's first turn, and this used to sit after it: nothing whatsoever reached the client
      // until the sandbox existed, so somebody who had just described their app watched an empty
      // pane for the whole of a cold start. Their own words come back first instead, and the same
      // event is what turns the preview pane to *starting* (`apps/web/src/preview/preview-state.ts`),
      // so the wait is something the UI can draw rather than a gap.
      //
      // Drained rather than left on the chain, because everything below is slow and a crash in it
      // would otherwise lose the one thing the person can see. Nothing is retracted if the sandbox
      // then cannot be had: the message is the record of what was asked, and a refusal that erased
      // it would leave a failure with no question above it. No job is opened and nothing is
      // committed on that path, exactly as before.
      emit("user.message", {
        text: request.message,
        ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
        ...(request.plan === undefined ? {} : { plan: request.plan }),
      });
      await sink.drain();

      // An approval names a plan, and the plan must still be the one waiting. Admission checked
      // this already; it is checked again here because only under the lease does the log stop
      // moving — two tabs approving the same plan both pass admission, and only one may build it.
      // Read from the history taken before this prompt was logged, which is what it answers.
      const approved =
        request.plan?.intent === "approve"
          ? pendingPlan(history, request.plan.planTurnId)
          : undefined;
      if (request.plan?.intent === "approve" && approved === undefined) {
        emit("turn.failed", { reason: "internal", message: STALE_APPROVAL });
        await sink.drain();
        return { ok: false, turnId, reason: "internal", message: STALE_APPROVAL };
      }

      const sandboxId = await this.#acquire(session, request.signal);
      if (!sandboxId.ok) {
        // A cancelled acquire reports itself as `unavailable`, the one code it has. Whoever is told
        // that was asked to stop rather than let down, so it ends the way any other abort does.
        request.signal?.throwIfAborted();
        emit("turn.failed", { reason: "sandbox_unavailable", message: sandboxId.error.message });
        await sink.drain();
        return {
          ok: false,
          turnId,
          reason: "sandbox_unavailable",
          message: sandboxId.error.message,
        };
      }

      // A plan mode turn opens no job, as a compaction does not: it is not meant to change
      // anything, so there is no commit to arbitrate, nothing to snapshot or photograph, and
      // nothing an open could find unfinished and continue (ADR-0025). The approval opens the job.
      if (request.plan?.intent === "propose") {
        for (const notice of sandboxId.value.notices) emit("system.notice", notice);
        const repository = sandboxId.value.repository;
        const previewPort = repository === undefined ? this.#previewPort : repository.previewPort;
        this.#startPreviewAnnouncement(scope, {
          acquired: sandboxId.value,
          history,
          port: previewPort,
          signal: request.signal,
        });
        return await this.#attempt({
          settings: {
            ...request,
            ...(repository === undefined ? {} : { workspace: "repository" }),
          },
          scope,
          sandboxId: sandboxId.value.id,
          previewPort,
          prompt: request.message,
          attachments: request.attachments,
          promptSource: "user",
          commitSubject: request.message,
          history,
          mode: "plan",
        });
      }

      // A job opens on a prompt, and this turn belongs to it. Opened after the sandbox is in
      // hand because a job that could never run is a job nothing will ever close — and the
      // objective repeats the message on purpose, so the log answers "what was asked" without
      // a reader having to work out which message belongs to which job.
      const jobId = crypto.randomUUID();
      // A job carrying out a plan is for what the plan is for: "Approved" says nothing about it.
      const objective = objectiveOf(approved === undefined ? request.message : approved.title);
      const plan =
        approved === undefined ? undefined : { title: approved.title, plan: approved.plan };
      emit("job.started", { jobId, objective });

      // Before the preview, which is about to show whatever state the notice is explaining.
      for (const notice of sandboxId.value.notices) emit("system.notice", notice);

      // Only for a sandbox the log has not announced (`preview-announced.ts`): one this turn
      // created, or one whose creating turn ended before its dev server answered. A resumed one
      // that was announced is already serving — the client replays that, and re-announcing would
      // reload the app underneath someone in the middle of using it, on every turn.
      //
      // Started, not awaited: the agent has no use for the preview, and a dev server reinstalling
      // dependencies after a restore would otherwise stand between the person and the first
      // model call for up to the whole timeout.
      const repository = sandboxId.value.repository;
      const previewPort = repository === undefined ? this.#previewPort : repository.previewPort;
      this.#startPreviewAnnouncement(scope, {
        acquired: sandboxId.value,
        history,
        port: previewPort,
        signal: request.signal,
      });

      run = {
        requestId: request.turnId,
        settings: { ...request, ...(repository === undefined ? {} : { workspace: "repository" }) },
        session,
        sink,
        sandboxId: sandboxId.value.id,
        jobId,
        objective,
        plan,
        attempts: [],
        repairs: 0,
        turn: scope,
        open: true,
        previewPort,
      };

      await this.#prepareRepositoryJob(run);

      const outcome = await this.#attempt({
        settings: run.settings,
        scope,
        sandboxId: run.sandboxId,
        previewPort: run.previewPort,
        prompt: request.message,
        attachments: request.attachments,
        promptSource: "user",
        commitSubject: approved === undefined ? request.message : approved.title,
        history,
        job: { objective, attempts: [], ...(plan === undefined ? {} : { plan }) },
      });

      return await this.#driveJob(run, { outcome, failed: null, announce: true, fresh: true });
    } catch (error) {
      const cancelled = request.signal?.aborted === true;
      const message = cancelled
        ? "The turn was cancelled."
        : error instanceof Error
          ? error.message
          : String(error);
      if (pendingCompaction !== undefined)
        emit("compaction.failed", { id: pendingCompaction, message, cancelled, usage: null });

      // Only if the turn is not already closed — a thrown error after a `turn.failed` would
      // otherwise close the same turn twice. Drained first, best effort, because an ending the
      // sink is holding until the preview is announced has not reached `terminal` yet.
      await sink.drain().catch(() => {});
      if (sink.terminal === null)
        emit("turn.failed", { reason: cancelled ? "cancelled" : "internal", message });

      // The job goes with it, whether or not the turn that crashed had already ended: a job left
      // open is one the next opening of this project would continue, spending tokens on the
      // aftermath of a crash. Tracked rather than inferred from the turn, because the throw can
      // land between a turn ending and the next one starting.
      if (run?.open === true) emit("job.completed", { jobId: run.jobId, outcome: "abandoned" });

      // Best effort: if persistence is what broke, there is nowhere left to record it.
      await sink.drain().catch(() => {});
      if (run !== null) {
        await this.#finishRepositoryJob({
          scope: run.turn,
          sandboxId: run.sandboxId,
          jobId: run.jobId,
          requestId: run.requestId,
          signal: request.signal,
        });
      }

      return {
        ok: false,
        turnId: (run?.turn ?? scope).turnId,
        reason: cancelled ? "cancelled" : "internal",
        message,
      };
    } finally {
      // Nothing this call promised may be written after it returns: the lease goes with it.
      await sink.settle().catch(() => {});
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
      if (!settings.work?.stopped)
        await this.#finishRepositoryJob({
          scope: run.turn,
          sandboxId,
          jobId,
          requestId: run.requestId,
          signal: settings.signal,
        });
    };

    let { outcome, failed, announce, fresh } = entry;

    for (;;) {
      if (settings.work?.stopped) {
        if (run.open) {
          emit("job.completed", { jobId, outcome: "abandoned" });
          run.open = false;
          await sink.drain();
        }
        return outcome;
      }
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
          previewPort: run.previewPort,
          signal: settings.signal,
        });
        // Every round after the first is one this loop began itself.
        announce = true;

        // Only for a turn this loop ran. A continued job is arbitrating a commit that reached
        // storage before the process died, and re-bundling it would pay for the same bytes
        // twice — and photograph an application nothing has changed since the last shot.
        if (fresh) {
          // Under the lease, unlike the picture below, and that is load-bearing: see the note on
          // `#preserve`.
          await this.#preserve(session.projectId, sandboxId, outcome.commitSha);
          // Only when the turn changed something — an unchanged app photographs identically — and
          // when no repair is about to edit it, since the app on screen is one its own checks just
          // called broken. Not for a turn that was stopped: a worker that has lost its lease does
          // nothing further on this session's behalf (`docs/scaling-design.md` §21, 10).
          if (
            outcome.commitSha !== null &&
            run.previewPort !== null &&
            settings.signal?.aborted !== true &&
            (failed === null || run.repairs >= MAX_REPAIR_ATTEMPTS)
          )
            await this.#photograph(session.projectId, sandboxId, run.previewPort);
        }

        // Arbitration closed the job: it passed, there was nothing to check, or the run learned
        // nothing about the project.
        if (failed === null) {
          run.open = false;
          await this.#finishRepositoryJob({
            scope: run.turn,
            sandboxId,
            jobId,
            requestId: run.requestId,
            signal: settings.signal,
          });
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
      // A fresh id, and the only kind this runtime still allocates. A repair is a distinct Turn
      // (docs/adr/0006) that shares the request's *lease* rather than its identity — the request
      // id names the Turn it began, and a repair is not that Turn. The repair prompt records
      // both identities so recovery can close this child without closing a later request.
      const repairTurnId = this.#newTurnId();
      run.turn = this.#scopeFor(session, sink, run.turn.history, settings.sessionId, repairTurnId);
      const repaired = failed;
      outcome = await withLogContext(getLogger(), { turnId: repairTurnId }, () =>
        this.#repair({
          requestId: run.requestId,
          jobId,
          settings,
          scope: run.turn,
          sandboxId,
          failed: repaired,
          previewPort: run.previewPort,
          attempt,
          job: {
            objective,
            attempts: [...attempts],
            ...(run.plan === undefined ? {} : { plan: run.plan }),
          },
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
    attachments?: TurnRequest["attachments"];
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
    job?: JobContext;
    manualCompaction?: { id: string; onSettled: () => void };
    appTest?: { run: AppTestRun; clock?: AppTestRecordingClock };
    previewPort: number | null;
    /** A plan mode turn: read-only, ending on a proposal, and never committed (ADR-0025). */
    mode?: "plan";
  }): Promise<TurnOutcome> {
    const { settings, scope, sandboxId, prompt, promptSource, commitSubject, history, job } =
      options;
    const { sink, emit, turnId } = scope;
    const appTest = options.appTest;

    // Preparation belongs to this turn too, even if it fails before the agent starts.
    sink.beginTurn();
    const compactionHistory = compactionHistoryFile({
      sandbox: this.#options.sandbox,
      sandboxId,
      sessionId: settings.sessionId,
    });
    // A replaced or restored sandbox comes back without the file a summary cites, so every
    // compacted session confirms it before the agent is told it is there.
    const historyFile = await compactionHistory.sync(history);
    const context = await this.#options.context.build({
      sessionId: settings.sessionId,
      sandboxId,
      userMessage: prompt,
      model: settings.model,
      attachments: options.attachments,
      history,
      historyFile,
      ...(job === undefined ? {} : { job }),
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.manualCompaction === undefined ? {} : { continuation: true }),
      sandbox: this.#options.sandbox,
      memory: this.#options.memory,
      ...(settings.workspace === undefined ? {} : { workspace: settings.workspace }),
    });

    settings.signal?.throwIfAborted();

    const computerAttempt = this.#options.computer?.coordinator.forTurn({
      projectId: scope.session.projectId,
      sandboxId,
      lease: settings.lease,
    });
    settings.work ??= { stopped: false };
    const work = settings.work;
    try {
      await this.#options.agent.runTurn({
        sessionId: settings.sessionId,
        turnId,
        sandboxId,
        context,
        sandbox: this.#options.sandbox,
        ...(this.#options.computer === undefined ||
        computerAttempt === undefined ||
        options.previewPort === null
          ? {}
          : {
              computer: {
                desktop: computerAttempt.desktop,
                stopped: () => computerAttempt?.stopped() ?? true,
                objects: this.#options.computer.objects,
                projectId: scope.session.projectId,
                devServerUrl: `http://localhost:${options.previewPort}`,
                beforeStore: () => sink.drain(),
                ...(appTest
                  ? {
                      annotate: async (annotation) =>
                        appTest.run.annotate(annotation, appTest.clock),
                      beforeAction: (action) => appTest.run.beforeAction(action),
                      afterAction: (action, succeeded) =>
                        appTest.run.afterAction(action, succeeded),
                      screenshotStored: (toolCallId) => appTest.run.screenshotStored(toolCallId),
                      delivered: (toolCallIds) => appTest.run.delivered(toolCallIds),
                    }
                  : {}),
              },
            }),
        onEvent: (event) => {
          sink.emit(event);
        },
        ...(settings.steering === undefined ||
        options.manualCompaction !== undefined ||
        appTest !== undefined
          ? {}
          : { steering: this.#steeringFor(settings.steering, scope) }),
        ...(options.manualCompaction === undefined ? {} : { operation: "compact" }),
        compactContext: contextCompactor({
          ...(options.manualCompaction === undefined
            ? {}
            : { startedId: options.manualCompaction.id }),
          budgetTokens: context.budgetTokens ?? 80_000,
          history: compactionHistory,
          read: async () => {
            await sink.drain();
            return scope.history.read();
          },
          emit: (event) => {
            switch (event.type) {
              case "compaction.started":
                emit(event.type, event.payload);
                break;
              case "compaction.completed":
                options.manualCompaction?.onSettled();
                emit(event.type, event.payload);
                break;
              case "compaction.failed":
                options.manualCompaction?.onSettled();
                emit(event.type, event.payload);
                break;
            }
          },
          drain: () => sink.drain(),
          rebuild: (history, historyFile) =>
            this.#options.context.build({
              sessionId: settings.sessionId,
              sandboxId,
              userMessage: prompt,
              model: settings.model,
              // A generated test prompt is not in durable user history. Reintroduce it as
              // the current request after compaction, without protecting it in later turns.
              continuation: appTest === undefined,
              history,
              historyFile,
              ...(job === undefined ? {} : { job }),
              ...(options.mode === undefined ? {} : { mode: options.mode }),
              sandbox: this.#options.sandbox,
              memory: this.#options.memory,
            }),
        }),
        promptSource,
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        // Nothing to commit after a plan mode turn: it may not change anything, and the agent
        // skips the commit of a turn that ended on a proposal besides. Both, because a turn that
        // stopped without proposing must not commit either.
        ...(options.manualCompaction !== undefined ||
        options.appTest !== undefined ||
        options.mode === "plan"
          ? {}
          : {
              finalize: async () => {
                if (computerAttempt?.stopped())
                  throw new Error("Computer input recovery is pending.");
                return this.#commit(sandboxId, commitSubject);
              },
            }),
        ...(settings.signal === undefined ? {} : { signal: settings.signal }),
        ...(settings.model === undefined ? {} : { model: settings.model }),
        // Passed straight through and read nowhere here: the runtime decides *when* a turn
        // runs, never who pays for it.
        ...(settings.credentials === undefined ? {} : { credentials: settings.credentials }),
      });
    } finally {
      if (computerAttempt) {
        const closed = await computerAttempt.close();
        if (!closed.ok || computerAttempt.stopped()) {
          work.stopped = true;
          scope.sandboxStopped = true;
          if (!closed.ok)
            emit("system.notice", {
              level: "warning",
              text: "Computer input recovery is pending. New work is blocked until input has drained.",
            });
        }
      }
    }

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
   * What the agent reads steers through: the request's waiting ones, each recorded where it is read.
   *
   * **Recorded before it is handed over, and durably.** The agent emits nothing for a steer; this
   * writes `steer.applied` under the turn reading it — after every event the agent emitted before
   * this step, since they share the sink — and drains before returning, so the log says a steer was
   * read before any model has read it. A drain that fails throws, and the turn fails as it would on
   * any other event it could not record.
   *
   * A queue that cannot be asked is not that: the next step asks again. Usually the steers are
   * still waiting for it, but not always — a take that committed and whose answer was lost on the
   * way back has marked them read with no event, and nothing offers those back (ADR-0027 D4).
   */
  #steeringFor(
    steering: RequestSteering,
    scope: TurnScope,
  ): NonNullable<AgentTurnRequest["steering"]> {
    return {
      take: async () => {
        let steers: Steer[];
        try {
          steers = await steering.take();
        } catch (error) {
          getLogger().warn(
            { err: error },
            "could not read waiting steers; asking at the next step",
          );
          return [];
        }
        if (steers.length === 0) return steers;
        for (const steer of steers)
          scope.emit("steer.applied", { steerId: steer.id, text: steer.text });
        await scope.sink.drain();
        return steers;
      },
    };
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
    requestId: string;
    jobId: string;
    settings: TurnSettings;
    scope: TurnScope;
    sandboxId: string;
    failed: CheckFailure;
    previewPort: number | null;
    attempt: number;
    job: JobContext;
  }): Promise<TurnOutcome> {
    const { settings, scope, sandboxId, failed, attempt, job } = options;
    const prompt = repairPrompt({ failed, attempt });

    getLogger().info({ check: failed.name, attempt }, "repairing a failed check");

    // Read before the prompt is logged, for the same reason the user's turn does it: the
    // context engine appends this turn's own message itself.
    const history = await scope.history.read();
    scope.emit("user.message", {
      text: prompt,
      repair: { requestId: options.requestId, jobId: options.jobId },
    });
    await scope.sink.drain();

    return await this.#attempt({
      settings,
      scope,
      sandboxId,
      previewPort: options.previewPort,
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
    previewPort: number | null;
    signal: AbortSignal | undefined;
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
    // client cannot render a gap. Settled rather than merely drained, because the checks probe
    // the preview themselves and its announcement should not trail the verdict on it.
    if (announce) emit("verification.started", { jobId });
    await sink.settle();

    const verified = await this.#runChecks(sandboxId, options.previewPort, options.signal);

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
  async #runChecks(
    sandboxId: string,
    previewPort: number | null,
    signal: AbortSignal | undefined,
  ): Promise<VerificationResult | null> {
    try {
      // Not checked, for the reason the keepalive at acquisition is not: the sandbox is about to be
      // asked to do something, and that answers whether it is still there.
      await this.#options.sandbox.extendTimeout(
        sandboxId,
        Math.max(this.#sandboxTtlMs, VERIFICATION_ROUND_LIMIT_MS),
      );
      return await verifyTurn({
        sandbox: this.#options.sandbox,
        sandboxId,
        previewPort,
        previewTimeoutMs: this.#previewTimeoutMs,
        signal,
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
   *
   * **It finishes before the lease goes back, which is the one thing here a person pays for and
   * the reason it is not beside the photograph.** The next turn may start on any worker, and the
   * only thing that orders two snapshots of one project, or a snapshot against the restore a
   * lost sandbox triggers, is that they never overlap. See `docs/scaling-design.md` §17 (B-7).
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
   * Asks for a picture of the project while it is still up, for the dashboard's card.
   *
   * **A picture can only be taken while a sandbox lives**, and the card is looked at days
   * later, when nothing is running to point a browser at. So every moment the project is
   * known to be serving is a chance worth taking: the end of a turn that changed something,
   * and a project coming back up.
   *
   * Whoever calls decides *whether* there is anything new to see — a turn that committed
   * nothing, or a sandbox that was already serving, has not changed since the last shot. What
   * happens after that is the lane's, and none of it is under the lease.
   */
  async #photograph(
    projectId: string,
    sandboxId: string,
    previewPort = this.#previewPort,
    wait: { previewTimeoutMs?: number } = {},
  ): Promise<void> {
    await this.#options.thumbnails?.request({ projectId, sandboxId, port: previewPort, ...wait });
  }

  /**
   * Tells the client where the project is served, once something actually answers there —
   * without making the turn wait for it.
   *
   * `waitForPreview` rather than `getPreviewUrl`: the second only composes an address, and a
   * preview shown before the dev server and its public proxy are both up is an error page.
   *
   * **Only when it is owed**, which `shouldAnnouncePreview` decides from whether this call
   * created the sandbox and what the log already says. Every entry point asks here, so none of
   * them can disagree about it.
   *
   * **Started, never awaited, and the sink is what makes that safe.** The event is handed to
   * `EventSink.eventually`, which writes it the moment the dev server answers, under the turn
   * that asked, wherever the stream has got to. The sink holds any turn or job ending emitted
   * meanwhile until it is known, so the rule a reader can rely on is: **a `preview.ready`
   * precedes the first ending emitted after it was started** — the turn's own on a turn, and on
   * a resume whichever the continuation it runs writes first. The two points this is settled at
   * are before verification, which probes the preview itself, and every entry point's exit,
   * because a write after the runtime returns is a write without a lease.
   *
   * **How long it waits is decided here too.** A sandbox this call created gets the full
   * `previewTimeoutMs`: it is expected to come up, a restore may be reinstalling dependencies, and
   * only its creating call is paying. One found running gets `previewRecheckMs`, since it is asked
   * about on every call and whatever ending is emitted meanwhile is held for the answer — except
   * before an app test's recording, which waits the full time either way: nothing short is held
   * up, and filming a server still coming up would record the wrong thing.
   *
   * A timeout is not a turn failure. A slow dev server is no reason to refuse to edit the
   * project — the pane keeps showing that it is starting, and the agent gets on with the work. A
   * cancelled turn stops waiting at once: the port takes no signal, so the wait is raced against
   * it, and the dev-server probe left running behind it writes nothing. Neither loses the
   * announcement for good: the log then holds none, so the next call that finds the sandbox
   * running starts it again.
   */
  #startPreviewAnnouncement(
    scope: TurnScope,
    options: {
      acquired: AcquiredSandbox;
      history: readonly StoredEvent[];
      port: number | null;
      signal: AbortSignal | undefined;
      /** Before an app test films the app, which takes the full wait. */
      recording?: true;
    },
  ): void {
    const { acquired, history, port, signal } = options;
    if (port === null || !shouldAnnouncePreview({ created: acquired.created, history })) return;
    // Not even started: a probe nobody will read is a polling loop running to its deadline.
    if (signal?.aborted) return;
    const { session, turnId, sink } = scope;
    const answered = unlessAborted(
      this.#options.sandbox.waitForPreview(acquired.id, port, {
        timeoutMs:
          acquired.created || options.recording === true
            ? this.#previewTimeoutMs
            : this.#previewRecheckMs,
      }),
      signal,
    );
    sink.eventually(
      answered.then((ready): PendingEvent | null =>
        ready?.ok === true
          ? {
              type: "preview.ready",
              payload: { url: ready.value, port },
              sessionId: session.sessionId,
              turnId,
              createdAt: this.#now(),
            }
          : null,
      ),
    );
  }

  /** See `acquire-sandbox.ts`, which owns the four paths and their ordering. */
  async #acquire(
    session: SessionRecord,
    signal?: AbortSignal,
  ): Promise<Result<AcquiredSandbox, SandboxError>> {
    return await acquireSandbox(
      {
        sandbox: this.#options.sandbox,
        sessions: this.#options.sessions,
        restore: this.#restore,
        ttlMs: this.#sandboxTtlMs,
        signal,
        ...(this.#options.repository === undefined ? {} : { repository: this.#options.repository }),
        ...(this.#options.capacity === undefined ? {} : { capacity: this.#options.capacity }),
      },
      session,
    );
  }

  async #prepareRepositoryJob(run: JobRun): Promise<void> {
    if (this.#options.repository === undefined) return;
    if (run.settings.signal?.aborted) throw new Error("The repository job was cancelled.");
    const prepared = await this.#options.repository.prepareJob({
      session: run.session,
      sandboxId: run.sandboxId,
      jobId: run.jobId,
      requestId: run.requestId,
      signal: run.settings.signal,
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    if (run.settings.signal?.aborted) throw new Error("The repository job was cancelled.");
  }

  async #finishRepositoryJob(options: {
    scope: TurnScope;
    sandboxId: string;
    jobId: string;
    requestId: string;
    signal?: AbortSignal | undefined;
  }): Promise<void> {
    if (this.#options.repository === undefined || options.scope.sandboxStopped) return;
    const { scope, sandboxId, jobId, requestId, signal } = options;
    try {
      const history = await scope.history.read();
      const completed = history.findLast(
        (event) => event.type === "job.completed" && event.payload.jobId === jobId,
      );
      if (completed?.type !== "job.completed") return;
      const finished = await this.#options.repository.finishJob({
        session: scope.session,
        sandboxId,
        jobId,
        requestId,
        signal,
        outcome: completed.payload.outcome,
      });
      if (!finished.ok) {
        scope.emit("system.notice", { level: "warning", text: finished.error.message });
        await scope.sink.drain();
      }
    } catch {
      scope.emit("system.notice", {
        level: "warning",
        text: "The job finished, but its GitHub update failed. You can retry publishing from this project.",
      });
      await scope.sink.drain().catch(() => {});
    }
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

/** `work`, or `null` the moment `signal` aborts — for a wait the port gives no way to cancel. */
function unlessAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | null> {
  if (signal === undefined) return work;
  if (signal.aborted) {
    // Abandoned unread, so a rejection would otherwise be unhandled.
    work.catch(() => {});
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const abandon = () => resolve(null);
    signal.addEventListener("abort", abandon, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abandon);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abandon);
        reject(error);
      },
    );
  });
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
