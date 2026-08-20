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
 * What deliberately stays in `index.ts`: reading and validating the environment, constructing the
 * real clients, the boot log line, and the signal handlers. Those are things a *process* does.
 */

import { NapAgentService } from "@nap/agent/agent-service";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { startReaper, sweepIdleProjects } from "@nap/runtime/reaper";
import { SingleAgentRuntime } from "@nap/runtime/single-agent-runtime";
import type { Logger } from "@nap/shared/logging";
import type { EventBus } from "@nap/shared/ports/event-bus";
import type { EventStore } from "@nap/shared/ports/event-store";
import type { LLMProvider } from "@nap/shared/ports/llm-provider";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { PageCapture } from "@nap/shared/ports/page-capture";
import type { ProjectSandboxStore } from "@nap/shared/ports/project-sandbox-store";
import type { ProjectStore } from "@nap/shared/ports/project-store";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SessionStore } from "@nap/shared/ports/session-store";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
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
import { TurnRateLimiter } from "./turns/rate-limiter.ts";
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
  | "NAP_TURNS_PER_HOUR"
  | "NAP_FREE_TURNS_PER_HOUR"
  | "NAP_MAX_SANDBOXES_PER_USER"
  | "NAP_FREE_MAX_SANDBOXES_PER_USER"
  | "NAP_MAX_SANDBOXES_TOTAL"
  | "NAP_SANDBOX_TTL_MINUTES"
  | "NAP_REAP_IDLE_MINUTES"
  | "NAP_REAP_INTERVAL_SECONDS"
>;

export type NapDeps = {
  config: NapConfig;
  /** Where this composition reports from. Also installed as the root logger by boot, not here. */
  logger: Logger;

  sessions: SessionStore;
  projects: ProjectStore;
  /** The reaper's slice of the same tables: which projects hold a sandbox, and since when. */
  projectSandboxes: ProjectSandboxStore;
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
  /** A browser to photograph finished turns with, if this deployment has one. */
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

export type ComposedNap = {
  app: Hono<{ Variables: AuthVariables }>;
  runtime: SingleAgentRuntime;
  /** Which turns are running here — read by the routes, the reaper and anything draining. */
  registry: TurnRegistry;
  /** Already sweeping. The caller owns stopping it, on a signal or at the end of a test. */
  reaper: { stop: () => void };
};

export function composeNap(deps: NapDeps): ComposedNap {
  const { config, logger } = deps;

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
    // A picture of each finished turn, and of each project coming back up.
    ...(deps.capture === undefined ? {} : { capture: deps.capture }),
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
      runtime,
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
      // What one person, and this whole process, may have running at once. This endpoint is the
      // only way to start a turn, so it is the only place either ceiling has to be applied.
      limits: {
        rate: new TurnRateLimiter({ limit: config.NAP_TURNS_PER_HOUR, windowMs: 60 * 60 * 1000 }),
        // The tighter one, for turns this deployment is paying for. Its own limiter rather than
        // its own number, so a person's paid turns cannot eat their free allowance.
        freeRate: new TurnRateLimiter({
          limit: config.NAP_FREE_TURNS_PER_HOUR,
          windowMs: 60 * 60 * 1000,
        }),
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
      // The same runtime the turn routes drive: resuming a project and running a turn in it are
      // serialized per session there, which is what stops the two starting two sandboxes.
      runtime,
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
      // Resuming makes a sandbox, so it answers to the same ceiling a turn does.
      limits: {
        projects: deps.projects,
        sandboxes: {
          perUser: config.NAP_MAX_SANDBOXES_PER_USER,
          total: config.NAP_MAX_SANDBOXES_TOTAL,
        },
      },
      // The same registry the turn routes write to and the reaper reads, so "busy" means one
      // thing everywhere: closing or deleting a project mid-turn is refused for the same reason
      // the reaper skips it.
      isBusy: (sessionIds) => sessionIds.some((id) => registry.isRunning(id)),
    },
  });

  /**
   * Sweeps up sandboxes nobody is using, snapshotting each one before destroying it.
   *
   * The busy check reuses the registry the turn routes already write to, which is the only
   * thing in this process that knows a turn is running. It reads across a project's sessions
   * because a sandbox belongs to the project they share.
   */
  const reaper = startReaper({
    intervalMs: config.NAP_REAP_INTERVAL_SECONDS * 1000,
    sweep: () =>
      sweepIdleProjects({
        projects: deps.projectSandboxes,
        sandbox: deps.sandbox,
        objects: deps.objects,
        snapshots: deps.snapshots,
        idleMs: config.NAP_REAP_IDLE_MINUTES * 60 * 1000,
        isBusy: (project) => project.sessionIds.some((id) => registry.isRunning(id)),
        // A swept project's tabs are still open on it, showing an address that is about to stop
        // answering. Same store and bus as everything else, for the same reason.
        announce: { events: deps.events, bus: deps.bus },
      }).then((result) => {
        if (result.reaped.length > 0) logger.info({ reaped: result.reaped }, "projects put away");
        // Their sandboxes were reclaimed by something else before we could snapshot them. Worth
        // a line each: a steady stream of these means the lifetimes above are wrong.
        for (const projectId of result.abandoned) {
          logger.warn({ projectId }, "sandbox was already gone; released without a snapshot");
        }
        for (const failure of result.failed)
          logger.error({ failure }, "could not put a project away");
      }),
    onError: (error) => logger.error({ err: error }, "reaper sweep threw"),
  });

  return { app, runtime, registry, reaper };
}
