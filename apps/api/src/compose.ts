/**
 * The composition: everything above the infrastructure, assembled from parts somebody else chose.
 *
 * `createApp` has always taken its dependencies injected; the layer underneath it — the runtime,
 * the context engine, the agent, the limiters, the reaper — was assembled by `index.ts` as
 * top-level side effects, which meant it could be built exactly one way: against E2B, R2,
 * OpenRouter and Postgres, at boot, in that process. Nothing else could build the same system
 * with different parts, so nothing else could measure it, and a second entrypoint would have had
 * to grow its own copy of the wiring and then drift from this one.
 *
 * So this file takes the infrastructure as arguments and returns the composed pieces, and
 * `index.ts` is left as the thin thing that reads the environment and calls it. **It decides no
 * policy of its own** — every number comes from `config`, every port from the caller — and that
 * is what makes a composition with fakes the same system rather than a similar one.
 *
 * What deliberately stays in `boot.ts`: reading and validating the environment, constructing the
 * real clients, the boot log line, and the signal handlers. Those are things a *process* does.
 *
 * **One composition, three processes.** `role` is what an API pod, a worker pod and the reaper
 * differ by, and it is a switch on what is *started* rather than on what is built: all three
 * assemble the same system from the same parts, and each turns on only the loops that are its job.
 * A composition function per role would have been three copies of six hundred lines of wiring, and
 * the copies would have drifted the first time somebody changed one.
 */

import { NapAgentService } from "@nap/agent/agent-service";
import { BoundedPageCapture } from "@nap/capture/bounded-page-capture";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { sweepOrphanedRequests } from "@nap/runtime/janitor";
import { sweepIdleProjects } from "@nap/runtime/reaper";
import { SingleAgentRuntime } from "@nap/runtime/single-agent-runtime";
import { startSweeping } from "@nap/runtime/sweep-schedule";
import { startTurnWorker, type TurnWorker } from "@nap/runtime/turn-worker";
import type { Logger } from "@nap/shared/logging";
import type { CapacityReconciler } from "@nap/shared/ports/capacity-reconciler";
import type { EventBus } from "@nap/shared/ports/event-bus";
import type { EventStore } from "@nap/shared/ports/event-store";
import type { LLMProvider } from "@nap/shared/ports/llm-provider";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { PageCapture } from "@nap/shared/ports/page-capture";
import type { ProjectSandboxStore } from "@nap/shared/ports/project-sandbox-store";
import type { ProjectStore } from "@nap/shared/ports/project-store";
import type { SandboxCapacity } from "@nap/shared/ports/sandbox-capacity";
import type { SandboxInventory } from "@nap/shared/ports/sandbox-inventory";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SessionStore } from "@nap/shared/ports/session-store";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
import type { SweepLock } from "@nap/shared/ports/sweep-lock";
import type { TurnQueue } from "@nap/shared/ports/turn-queue";
import type { TurnRateLimiter } from "@nap/shared/ports/turn-rate-limit";
import type { UserKeyStore } from "@nap/shared/ports/user-key-store";
import type { Hono } from "hono";
import type { VerifyKey } from "./account/routes.ts";
import { type EncryptionKey, open } from "./account/secret-box.ts";
import { createApp, type UpgradeWebSocket } from "./app.ts";
import type { Authenticate, AuthInstance } from "./auth/auth.ts";
import type { AuthVariables } from "./auth/require-user.ts";
import type { Env } from "./env.ts";
import type { HealthProbe } from "./health.ts";
import type { CreatedProject } from "./projects/routes.ts";
import { TurnRegistry } from "./turns/registry.ts";

/**
 * The settings the composition reads, and nothing else.
 *
 * A `Pick` of `Env` rather than a type of its own, so boot passes `env` straight through with no
 * mapping to keep in step — while a caller with no environment at all (a test, a load harness)
 * writes an object literal and is not asked for a database URL or a bucket it will never use.
 */
export type NapConfig = Pick<
  Env,
  | "NAP_WEB_ORIGIN"
  | "NAP_MODEL"
  | "NAP_FREE_MODEL"
  | "NAP_ALLOWED_MODELS"
  | "NAP_MAX_STEPS"
  | "NAP_CONTEXT_BUDGET_TOKENS"
  | "NAP_MAX_SANDBOXES_PER_USER"
  | "NAP_FREE_MAX_SANDBOXES_PER_USER"
  | "NAP_MAX_SANDBOXES_TOTAL"
  | "NAP_SANDBOX_TTL_MINUTES"
  | "NAP_WORKER_CONCURRENCY"
  | "NAP_DRAIN_TIMEOUT_SECONDS"
  | "NAP_CAPTURE_CONCURRENCY"
  | "NAP_REAP_IDLE_MINUTES"
  | "NAP_REAP_INTERVAL_SECONDS"
  | "NAP_JANITOR_INTERVAL_SECONDS"
>;

/**
 * Which part of the deployment this process is.
 *
 * `docs/scaling-design.md` §4 and §13: an API pod owns HTTP, WebSockets, auth and admission and
 * executes nothing; a worker pod owns executing turns and serves nothing; the reaper owns the
 * periodic tidying — idle projects, orphaned requests, leaked capacity, expired rate events — and
 * neither serves nor executes. `all` is the three in one process, which is what a
 * single-container deployment, the load harness and every test compose.
 *
 * **The reaper is one replica and the others are many**, which is the reason it is a role of its
 * own rather than a job the workers share: several sweeps at once would each snapshot and destroy
 * the same project, and the second one would do it to a sandbox that is already gone. One replica
 * is not quite enough on its own either — a rolling update runs two for a few seconds — so the
 * sweep is additionally guarded by `sweepLock`.
 *
 * It gates the *loops*, never the objects: a worker still builds the Hono app it never serves and
 * an API still builds the runtime it never drives, because the alternative is a composition
 * function per role and three sets of assumptions about which dependencies each is allowed to
 * skip. Nothing here has a side effect until something starts it.
 */
export type NapRole = "api" | "worker" | "reaper" | "all";

export type NapDeps = {
  config: NapConfig;
  /** Defaults to `all`: a composition that was not told is one process doing everything. */
  role?: NapRole;
  /** Where this composition reports from. Also installed as the root logger by boot, not here. */
  logger: Logger;

  sessions: SessionStore;
  projects: ProjectStore;
  /** The reaper's slice of the same tables: which projects hold a sandbox, and since when. */
  projectSandboxes: ProjectSandboxStore;
  /**
   * The ceiling on how many sandboxes exist at once — the only thing bounding this deployment's
   * E2B bill, and the reason it is required rather than optional.
   *
   * The route's quota check in `limits.sandboxes` is a cheap refusal in front of this and is not
   * authoritative: it counts and then, some time later, something creates. This is claimed at the
   * moment of creation, atomically, so a burst of admissions cannot all find themselves under the
   * cap at once. A composition that forgot it would run unlimited and every test would still
   * pass, which is exactly how the limits block once failed to reach boot at all.
   */
  capacity: SandboxCapacity;
  /**
   * How fast one person may spend, in both tiers — the other ceiling that bounds the bill, and
   * required for the same reason `capacity` is.
   *
   * **Two limiters, never one shared.** The window is per tier as well as per user, so a single
   * allowance would let somebody's paid turns eat their free one and make "5 free turns an hour"
   * mean something different depending on what else they did.
   *
   * Handed in rather than constructed here because the window lives in Postgres now: a limiter
   * needs a database, and what a deployment is willing to spend is boot's fact rather than the
   * composition's. A composition given a per-process limiter still works — it is what a test
   * wants — but it is one allowance per replica, which is the thing this stopped being.
   */
  rateLimits: { rate: TurnRateLimiter; freeRate: TurnRateLimiter };
  /**
   * Where an admitted turn is written down, and where this composition's worker takes it from.
   *
   * Required, and the reason it cannot be optional is the one `capacity` gives: a composition
   * without it would type-check, boot, accept turns and run none of them. **One queue per
   * database, never per process** — the whole point is that the lease is visible to every replica.
   */
  queue: TurnQueue;
  /**
   * How the reaper puts back capacity nothing gave back, if this composition can offer it.
   *
   * Optional because both halves are real infrastructure — the reservations table and the
   * provider's own list of what it is running — and a composition holding neither still serves
   * every request. What it loses is self-healing: a process killed mid-creation costs a slot of
   * the ceiling until the next deploy, and a sandbox created just before the row recording it
   * failed is billed until somebody notices.
   */
  reconcile?: { reconciler: CapacityReconciler; inventory: SandboxInventory };
  /**
   * What stops two reapers sweeping at once, if this composition was given one.
   *
   * Only the idle sweep asks it, and only in a process whose role sweeps. Absent means "sweep
   * whenever the timer says so", which is right for a single-container deployment and for every
   * test, and wrong for a deployment where a rollout briefly runs two reapers — see `SweepLock`.
   */
  sweepLock?: SweepLock;
  snapshots: SnapshotStore;
  userKeys: UserKeyStore;
  /**
   * One store and one bus, handed to the runtime that publishes *and* the socket that
   * subscribes. Taking them as one pair rather than two is the point: a second pair type-checks,
   * boots, and streams nothing (`docs/GOTCHAS.md`, API section).
   */
  events: EventStore;
  bus: EventBus;
  sandbox: SandboxManager;
  objects: ObjectStore;
  /** Model policy is the provider's; which provider it is, is the caller's. */
  provider: LLMProvider;
  /**
   * A browser to photograph finished turns with, if this deployment has one.
   *
   * Handed over unbounded: this composition is what puts a semaphore in front of it, because how
   * many browsers may be open at once is a property of the *process running turns* rather than of
   * the browser, and only this layer knows what that process's concurrency is.
   */
  capture?: PageCapture;

  /** Sign-in and the OAuth callback, if this composition has any. */
  auth?: AuthInstance;
  /** How a request becomes a caller. Defaults to `auth.getUser`; absent means refuse everyone. */
  authenticate?: Authenticate;
  /** The secret that seals the keys people bring with them. */
  encryptionKey: EncryptionKey;
  verifyKey: VerifyKey;
  createProject: (options: { userId: string; name?: string }) => Promise<CreatedProject>;
  /**
   * Turning a request into a WebSocket, which needs a running `Bun.serve` and so cannot be
   * built here — see `UpgradeWebSocket`.
   */
  upgradeWebSocket: UpgradeWebSocket;
  /**
   * What `/health` reports. Built by the caller because the sandbox provider's `ping()` is
   * deliberately not on the `SandboxManager` port — "is E2B up?" is a question about the
   * deployment, not about one project's workspace. Absent means liveness only.
   */
  health?: HealthProbe;
  /**
   * What `/readyz` answers with a status code — narrower than `health`, and built by the caller
   * for the same reason. Absent means ready. See `AppDeps.readiness`.
   */
  readiness?: HealthProbe;
};

/**
 * A background loop this role does not run.
 *
 * Returned rather than `undefined` so that every caller's shutdown sequence is the same three
 * lines whichever half it composed: a process that has to ask which of its pieces exist before it
 * can stop them is a process that will one day forget to stop one.
 */
const NOT_STARTED = { stop: () => {} };
const NOT_CLAIMING: TurnWorker = { stop: async () => {} };

export type ComposedNap = {
  app: Hono<{ Variables: AuthVariables }>;
  runtime: SingleAgentRuntime;
  /**
   * Which turns are running *in this process* — the fast path for a cancel that lands on the pod
   * holding the turn, and nothing else now that "busy" is a lease.
   */
  registry: TurnRegistry;
  /**
   * Already claiming, unless the role is `api`, in which case it never claims anything. The caller
   * owns stopping it either way — on a signal, or at the end of a test.
   */
  worker: TurnWorker;
  /** Already sweeping, unless the role is `api`. The caller owns stopping it. */
  reaper: { stop: () => void };
  /**
   * Already looking for turns whose worker died, unless the role is `api`. The caller owns
   * stopping it.
   *
   * A schedule of its own rather than a share of the reaper's: an idle project can wait a minute
   * to be put away, and a chat pane waiting on a turn that will never finish cannot.
   */
  janitor: { stop: () => void };
};

export function composeNap(deps: NapDeps): ComposedNap {
  const { config, logger } = deps;
  const role = deps.role ?? "all";
  /** The part that executes: the claiming loop, and nothing else. */
  const executes = role === "worker" || role === "all";
  /** The part that tidies: both timers, and nothing else. */
  const sweeps = role === "reaper" || role === "all";

  const registry = new TurnRegistry();
  // Absent means refuse, not allow — see `requireUser`. Boot always has an auth instance, and a
  // test that wants a stub caller passes one directly rather than assembling a whole library.
  const authenticate = deps.authenticate ?? deps.auth?.getUser;

  const runtime = new SingleAgentRuntime({
    sessions: deps.sessions,
    sandbox: deps.sandbox,
    // With these, a project outlives its sandbox: a session whose sandbox is gone is restored
    // from its last snapshot rather than starting again from an empty template.
    objects: deps.objects,
    snapshots: deps.snapshots,
    // A picture of each finished turn, and of each project coming back up — behind a semaphore,
    // because this runs after *every* committed turn and a worker holding 25 at once would
    // otherwise launch 25 Chromiums in one container. Capture is best-effort and nobody waits on
    // it, so queueing costs a card that appears late where the alternative costs the whole pod.
    ...(deps.capture === undefined
      ? {}
      : {
          capture: new BoundedPageCapture(deps.capture, {
            concurrency: config.NAP_CAPTURE_CONCURRENCY,
          }),
        }),
    // Where the ceiling is really enforced: at the point a sandbox is created, not at the route
    // that asked for one.
    capacity: deps.capacity,
    sandboxTtlMs: config.NAP_SANDBOX_TTL_MINUTES * 60 * 1000,
    context: new NapContextEngine({ budgetTokens: config.NAP_CONTEXT_BUDGET_TOKENS }),
    agent: new NapAgentService({
      provider: deps.provider,
      budget: { maxSteps: config.NAP_MAX_STEPS },
    }),
    events: deps.events,
    bus: deps.bus,
    memory: new NoopMemoryProvider(),
  });

  /**
   * The one place ciphertext becomes a credential.
   *
   * It answers `null` for anything it cannot open — a key sealed under a secret that has since
   * been rotated — which puts that person back on the free tier rather than failing their turn
   * with something they cannot act on. Their next save fixes it, and the log line says why.
   */
  const openCallerKey = async (userId: string) => {
    const stored = await deps.userKeys.get(userId);
    if (stored === null) return null;

    const opened = open({ ciphertext: stored.ciphertext, iv: stored.iv }, deps.encryptionKey);
    if (!opened.ok) {
      logger.warn({ userId, reason: opened.reason }, "stored API key could not be opened");
      return null;
    }

    return { platform: stored.platform, apiKey: opened.value };
  };

  const app = createApp({
    logger,
    ...(deps.health === undefined ? {} : { health: deps.health }),
    ...(deps.readiness === undefined ? {} : { readiness: deps.readiness }),
    // The browser app is on another port, so every request it makes is cross-origin and every
    // session cookie depends on this being right.
    webOrigin: config.NAP_WEB_ORIGIN,
    ...(deps.auth === undefined ? {} : { auth: deps.auth }),
    // The same instance answers "who is this?" for every guarded route. Passing the function
    // rather than letting `createApp` reach into `auth` keeps the app's dependency a plain one.
    ...(authenticate === undefined ? {} : { authenticate }),
    stream: {
      store: deps.events,
      bus: deps.bus,
      sessions: deps.sessions,
      upgradeWebSocket: deps.upgradeWebSocket,
    },
    files: { sessions: deps.sessions, sandbox: deps.sandbox },
    account: {
      keys: deps.userKeys,
      encryptionKey: deps.encryptionKey,
      verify: deps.verifyKey,
    },
    models: {
      allowed: config.NAP_ALLOWED_MODELS,
      fallback: config.NAP_MODEL,
      freeModel: config.NAP_FREE_MODEL,
      // The stored record, not the opened key: the picker needs the platform and the hint, and
      // nothing on that route spends anything.
      keys: (userId) => deps.userKeys.get(userId),
    },
    turns: {
      queue: deps.queue,
      registry,
      sessions: deps.sessions,
      // Who pays for each turn, which is also what decides the models they may name.
      keys: openCallerKey,
      freeModel: config.NAP_FREE_MODEL,
      defaultModel: config.NAP_MODEL,
      // The same store the project routes list from, so a project named on its first turn and one
      // renamed by hand are written through one code path.
      projects: deps.projects,
      allowedModels: config.NAP_ALLOWED_MODELS,
      // What one person, and everybody together, may have running at once. This endpoint is the
      // only place either ceiling is applied *early* — the sandbox one is applied for real when a
      // sandbox is created, and `sandbox-quota.ts` says why the cheap refusal is worth keeping.
      limits: {
        rate: deps.rateLimits.rate,
        // The tighter one, for turns this deployment is paying for. Its own limiter rather than
        // its own number, so a person's paid turns cannot eat their free allowance.
        freeRate: deps.rateLimits.freeRate,
        projects: deps.projects,
        sandboxes: {
          perUser: config.NAP_MAX_SANDBOXES_PER_USER,
          total: config.NAP_MAX_SANDBOXES_TOTAL,
        },
        freeSandboxes: {
          perUser: config.NAP_FREE_MAX_SANDBOXES_PER_USER,
          total: config.NAP_MAX_SANDBOXES_TOTAL,
        },
      },
    },
    projects: {
      projects: deps.projects,
      projectSandboxes: deps.projectSandboxes,
      snapshots: deps.snapshots,
      objects: deps.objects,
      sandbox: deps.sandbox,
      createProject: deps.createProject,
      // The same queue the turn routes write to, and the same one this composition's worker
      // claims from: an open is a `resume` request that takes the session's lease exactly as a
      // turn does, which is what stops the two starting two sandboxes for one project.
      queue: deps.queue,
      // Opening a project can continue a job a restart left open, which spends tokens — so it is
      // billed exactly as a turn is, to whoever is standing in front of it.
      models: {
        keys: openCallerKey,
        allowedModels: config.NAP_ALLOWED_MODELS,
        freeModel: config.NAP_FREE_MODEL,
        defaultModel: config.NAP_MODEL,
      },
      // The same store and bus the socket subscribes to, or a close would append `preview.stopped`
      // to a log nobody is listening on.
      events: { events: deps.events, bus: deps.bus },
      // A close destroys a sandbox, so it is where that sandbox's slot comes back.
      capacity: deps.capacity,
      // Resuming makes a sandbox, so it answers to the same ceiling a turn does.
      limits: {
        projects: deps.projects,
        sandboxes: {
          perUser: config.NAP_MAX_SANDBOXES_PER_USER,
          total: config.NAP_MAX_SANDBOXES_TOTAL,
        },
      },
      // The lease in the queue, which is what "busy" means everywhere now: the same rows the
      // reaper's sweep filters on, and the same rows a worker on another pod is holding. The
      // in-memory registry this replaced knew only about turns claimed in *this* process, so an
      // API pod composed apart from its workers read every busy session as idle and would happily
      // close a project mid-turn.
      isBusy: (sessionIds) => deps.queue.anyLeased(sessionIds),
    },
  });

  /**
   * Sweeps up sandboxes nobody is using, snapshotting each one before destroying it.
   *
   * **It is a process of its own now**, and no longer travels with the turns. It used to have to:
   * the busy check was an in-memory registry, so only the process holding the turns could answer
   * it. Reading the lease instead frees the sweep to run anywhere — and it must run in exactly
   * one place, because several replicas would each snapshot and destroy the same project, the
   * second one against a sandbox that is already gone.
   *
   * **One replica is not the guarantee; `sweepLock` is.** A rolling update runs the new reaper
   * while the old one is still shutting down, so each tick asks the lock first and does nothing
   * if another process holds it. A composition with no lock sweeps unguarded, which is right for
   * a single container and for tests.
   *
   * The busy check stays a *filter* rather than becoming a lock over the project, which is the
   * character `sweepIdleProjects` was written with: a turn that starts in the moment between the
   * check and the destroy loses its sandbox and is restored from the snapshot this just took,
   * while a lock held across a teardown means a wedged sweep blocks turns.
   */
  const reaper = !sweeps
    ? NOT_STARTED
    : startSweeping({
        intervalMs: config.NAP_REAP_INTERVAL_SECONDS * 1000,
        // In the reaper process this timer is the only thing referencing the event loop; see
        // `SweepSchedule`. Harmless in a composition that also serves or claims.
        holdProcessOpen: role === "reaper",
        sweep: async () => {
          // Before anything with a cost. Whoever holds the lock is mid-sweep or about to be, and
          // a second process doing this work would be tearing down projects underneath them.
          if (deps.sweepLock !== undefined && !(await deps.sweepLock.held())) return;

          // Turns recorded long enough ago that no window can still count them. Cheap, unrelated to
          // the projects below, and here for the reason reconciliation is: this is the deployment's
          // "come past occasionally and put things right" schedule, and without it the table keeps a
          // row for every visitor who ever sent one message.
          await Promise.all(
            [deps.rateLimits.rate, deps.rateLimits.freeRate].map((limiter) =>
              limiter.sweep().catch((error: unknown) => {
                // Its own catch, not the sweep's: a failure to tidy must not cost this tick the
                // projects it was about to put away, which is the half that spends money.
                logger.error({ err: error }, "could not sweep expired turn rate events");
              }),
            ),
          );

          return await sweepIdleProjects({
            projects: deps.projectSandboxes,
            sandbox: deps.sandbox,
            objects: deps.objects,
            snapshots: deps.snapshots,
            // A swept sandbox is the main way capacity ever comes back; without this the ceiling
            // would count every project this cluster had ever opened.
            capacity: deps.capacity,
            // The other half of the same tick: slots no path gave back, and sandboxes running under
            // an id nothing in the database ever recorded. See `reconcileCapacity`.
            ...(deps.reconcile === undefined ? {} : { reconcile: deps.reconcile }),
            idleMs: config.NAP_REAP_IDLE_MINUTES * 60 * 1000,
            // The same question the close and delete routes ask, of the same rows: a project is
            // busy while any of its sessions holds a lease, wherever the worker holding it is.
            isBusy: (project) => deps.queue.anyLeased(project.sessionIds),
            // A swept project's tabs are still open on it, showing an address that is about to stop
            // answering. Same store and bus as everything else, for the same reason.
            announce: { events: deps.events, bus: deps.bus },
          }).then((result) => {
            if (result.reaped.length > 0)
              logger.info({ reaped: result.reaped }, "projects put away");
            // Their sandboxes were reclaimed by something else before we could snapshot them. Worth
            // a line each: a steady stream of these means the lifetimes above are wrong.
            for (const projectId of result.abandoned) {
              logger.warn({ projectId }, "sandbox was already gone; released without a snapshot");
            }
            for (const failure of result.failed)
              logger.error({ failure }, "could not put a project away");

            const reconciled = result.reconciled;
            if (reconciled !== undefined) {
              // Logged only when something moved, because the healthy answer is three empty lists
              // every tick forever. A number that keeps climbing is the signal worth seeing: it
              // means processes are dying between reserving a slot and using it.
              if (
                reconciled.expired.length +
                  reconciled.orphaned.length +
                  reconciled.destroyed.length >
                0
              ) {
                logger.warn(
                  {
                    expired: reconciled.expired.length,
                    orphaned: reconciled.orphaned.length,
                    destroyed: reconciled.destroyed,
                  },
                  "reclaimed sandbox capacity nothing gave back",
                );
              }
              for (const failure of reconciled.failed)
                logger.error({ failure }, "could not reconcile sandbox capacity");
            }
          });
        },
        onError: (error) => logger.error({ err: error }, "reaper sweep threw"),
      });

  /**
   * The loop that actually runs the queued turns, and the whole of what a worker process is.
   *
   * An API composition does not start it, which is the single line that makes an API pod execute
   * nothing: everything above is built the same way either half is composed, and turns reach a
   * worker through the durable queue rather than through anything in this process. Started after
   * the app so the registry it writes to is the same one the cancel route reads.
   */
  const worker = !executes
    ? NOT_CLAIMING
    : startTurnWorker({
        queue: deps.queue,
        runtime,
        concurrency: config.NAP_WORKER_CONCURRENCY,
        // How long a shutdown waits for turns in flight before aborting them. Config rather than
        // the port's default, because what fits depends on the platform's grace period.
        drainTimeoutMs: config.NAP_DRAIN_TIMEOUT_SECONDS * 1000,
        // The same function the turn route resolves access with — the queue stores only *whether*
        // the asker pays, so this is where their key is re-opened, once the request is claimed.
        credentialsFor: openCallerKey,
        running: registry,
      });

  /**
   * The other half of a worker dying: the request it was holding, and the chat pane waiting on a
   * turn that will never finish.
   *
   * **It lives in the reaper process, on a ticker of its own, and is not under the sweep lock.**
   * That is `docs/scaling-design.md` §24 item 3 answered rather than left open, and each half of
   * it is a separate argument:
   *
   *   - *Same process*, because it is a timer over one table with no sandbox, no object store and
   *     no browser behind it. A process of its own would be a third deployment to run and pay for
   *     in order to hold one query.
   *   - *Its own ticker*, because the two answer to different clocks: an idle project can wait a
   *     minute to be put away, and a chat pane waiting on a turn that will never finish cannot.
   *     `NAP_JANITOR_INTERVAL_SECONDS` is deliberately the tighter of the two.
   *   - *Not under the lock*, because unlike the sweep it is safe to run twice over — the reclaim
   *     holds each row with `for update skip locked`, so two janitors never close out the same
   *     request — and because the moment two of them exist is a rolling update, which is exactly
   *     when a worker is being taken away and its turns are being orphaned. Making the new process
   *     wait for the old one's lock would delay the announcements at the only time they are
   *     needed in bulk.
   */
  const janitor = !sweeps
    ? NOT_STARTED
    : startSweeping({
        intervalMs: config.NAP_JANITOR_INTERVAL_SECONDS * 1000,
        holdProcessOpen: role === "reaper",
        sweep: async () => {
          const result = await sweepOrphanedRequests({
            queue: deps.queue,
            // The same store and bus as everything else: the terminal event it writes is replayed
            // from the log by whoever reconnects, exactly like the ones a turn writes.
            events: deps.events,
            bus: deps.bus,
          });

          // Logged here rather than inside the sweep, for the reason the reconciliation pass is: the
          // sweep answers with values and the composition owns what is worth a line. Only when
          // something moved — in a healthy deployment every tick finds nothing, and a number that
          // climbs means workers are dying rather than settling their requests.
          if (result.orphaned.length > 0) {
            logger.warn(
              { orphaned: result.orphaned },
              "turn requests outlived their leases and were closed out; their jobs are still open",
            );
          }
          for (const failure of result.failed) {
            logger.error({ failure }, "could not close out an interrupted turn");
          }
        },
        onError: (error) => logger.error({ err: error }, "janitor sweep threw"),
      });

  return { app, runtime, registry, worker, reaper, janitor };
}
