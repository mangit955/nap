/**
 * Whether the things this API cannot work without are reachable.
 *
 * Liveness — "the process is running" — is what answering at all proves. What this adds is
 * readiness: the database holds every project and every event, and the sandbox provider is
 * where the user's app actually runs, so an API that is up while either is unreachable can
 * accept a message and then fail every turn. Naming the dependency is the point; "degraded"
 * on its own only tells an operator to start looking.
 *
 * Three properties matter more than the checking itself, and each is the answer to a way a
 * health endpoint makes an outage worse rather than better:
 *
 *  - **A failed probe is a report, never an exception.** An endpoint that 500s because one
 *    dependency is down says nothing about the ones that are still up.
 *  - **Every probe has a deadline.** The characteristic database failure is not a refused
 *    connection but an accepted one that never answers, and a health check with no timeout
 *    stops responding at precisely the moment somebody is trying to find out why.
 *  - **Results are cached and concurrent polls share one round.** This route is public — it
 *    has to be, since whatever polls it has no session — so without a cache anyone who can
 *    reach it can drive unlimited load against the sandbox provider's API at our expense.
 */

export type DependencyStatus = "ok" | "down";

export type HealthReport = {
  status: "ok" | "degraded";
  /** Keyed by dependency name, so the answer says *which* rather than only *whether*. */
  checks: Record<string, DependencyStatus>;
};

/**
 * One dependency and how to ask it whether it is there.
 *
 * `probe` reports by resolving or rejecting rather than by returning a boolean: every client
 * this wraps already throws on failure, and a boolean would mean each call site inventing its
 * own idea of what counts as reachable.
 */
export type HealthCheck = {
  name: string;
  probe: () => Promise<unknown>;
};

export type HealthProbeOptions = {
  checks: HealthCheck[];
  /** How long a dependency has to answer before it is treated as down. */
  timeoutMs?: number;
  /** How long a report is reused for. */
  ttlMs?: number;
  /** Injected so the cache can be tested without waiting. */
  now?: () => number;
};

/**
 * Long enough for a serverless database's first connection, which is the case that matters.
 *
 * This was 2000ms and it was wrong, found by booting against a real Neon instance: one that has
 * scaled to zero takes **~1.8s** to answer its first query, so the first poll after a cold start
 * raced it and reported `degraded` on a perfectly healthy system. A false outage is worse than a
 * missed one — it is the reading that teaches people to stop trusting the endpoint, and anything
 * automated watching it would act on a lie. 5s leaves real margin over the measurement while
 * staying well inside any sensible poll interval.
 */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Long enough that polling costs nothing, short enough that a recovery is visible quickly.
 * A dependency that comes back is reported up within this, which is the number that matters —
 * being slow to notice a recovery keeps an instance out of rotation after it is healthy.
 */
const DEFAULT_TTL_MS = 5000;

export function createHealthProbe(options: HealthProbeOptions): () => Promise<HealthReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;

  let cached: { at: number; report: HealthReport } | null = null;
  /** The round currently running, so simultaneous polls wait on it instead of starting more. */
  let inFlight: Promise<HealthReport> | null = null;

  return async function poll(): Promise<HealthReport> {
    if (cached !== null && now() - cached.at < ttlMs) return cached.report;
    if (inFlight !== null) return await inFlight;

    inFlight = runChecks(options.checks, timeoutMs).then((report) => {
      cached = { at: now(), report };
      return report;
    });

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };
}

async function runChecks(checks: HealthCheck[], timeoutMs: number): Promise<HealthReport> {
  const results = await Promise.all(
    checks.map(async (check) => [check.name, await probe(check, timeoutMs)] as const),
  );

  return {
    status: results.some(([, status]) => status === "down") ? "degraded" : "ok",
    checks: Object.fromEntries(results),
  };
}

async function probe(check: HealthCheck, timeoutMs: number): Promise<DependencyStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<DependencyStatus>((resolve) => {
    timer = setTimeout(() => resolve("down"), timeoutMs);
  });

  try {
    // Called inside the `try` so a probe that throws synchronously is caught alongside one
    // that rejects. A rejection arriving *after* the deadline is harmless rather than an
    // unhandled one that would end the process: `Promise.race` stays subscribed to both sides
    // and simply ignores whichever settles second. There is a test pinning that.
    const answered = Promise.resolve(check.probe()).then((): DependencyStatus => "ok");
    return await Promise.race([answered, deadline]);
  } catch {
    return "down";
  } finally {
    // Or every poll leaves a live timer behind, several times a minute, forever.
    clearTimeout(timer);
  }
}
