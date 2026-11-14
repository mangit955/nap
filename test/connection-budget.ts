/**
 * Whether a deployment's processes can all hold their connections at once without the database
 * refusing one.
 *
 * Postgres refuses a connection past `max_connections` with `too many clients already`, and it is
 * the process that asked last that pays: a worker mid-turn, a new pod's first query, or the
 * release's own migration. Nothing reports the arithmetic beforehand, which is why it is a test.
 *
 * **A pool is a ceiling, not a reservation, and the ceiling is what counts.** postgres.js opens
 * connections as concurrent queries need them and keeps them open, so a process that was busy once
 * holds its whole pool from then on.
 *
 * **A rollout can run two whole generations of a process at once.** A replaced pod keeps its
 * connections for as long as its drain lasts, and a worker's drain can run for minutes. Kubernetes
 * leaves terminating pods out of `maxSurge`, so even at a surge of one it goes on starting
 * replacements while every old replica may still be draining: one ordinary rolling update can hold
 * the whole old generation and the whole new one together. So the peak is every replica of every
 * process twice, plus the migration the release runs first. The reaper is counted twice as well,
 * although its `Recreate` strategy should never overlap it, because a ceiling that leans on that
 * is one strategy change from being wrong.
 *
 * **This covers one rollout at a time.** A second release started while the first one's old
 * generation is still draining would put a third generation beside them, and nothing here budgets
 * for that: the next rollout waits until the previous generation has exited.
 */

/** Postgres keeps `superuser_reserved_connections`, three by default, out of the ordinary budget. */
export const POSTGRES_RESERVED_CONNECTIONS = 3;

/** What the release's migration holds while it runs: one connection. */
export const MIGRATION_CONNECTIONS = 1;

export type DeployedProcess = {
  /** How the deployment names it, for the message. */
  name: string;
  /** The most replicas it can run, an autoscaler's maximum where there is one. */
  replicas: number;
  /** What one replica holds: its pool, plus the connections that are not the pool's. */
  connections: number;
};

/** How many generations of each process one rollout can hold at once: the old and the new. */
export const ROLLOUT_GENERATIONS = 2;

/** The most connections the deployment can hold at one moment, during one rollout. */
export function peakConnections(processes: DeployedProcess[]): number {
  const generation = processes.reduce((sum, p) => sum + p.replicas * p.connections, 0);
  return ROLLOUT_GENERATIONS * generation + MIGRATION_CONNECTIONS;
}

/**
 * Empty when the deployment fits under `maxConnections`; otherwise one message saying by how much
 * and what each process contributes to one generation, which a rollout holds twice.
 */
export function connectionBudgetViolations(
  processes: DeployedProcess[],
  maxConnections: number,
): string[] {
  const usable = maxConnections - POSTGRES_RESERVED_CONNECTIONS;
  const peak = peakConnections(processes);
  if (peak <= usable) return [];

  const parts = processes.map((p) => `${p.name}: ${p.replicas} × ${p.connections}`).join(", ");
  return [
    `can hold ${peak} connections at once, over the ${usable} the database allows ` +
      `(${maxConnections} less ${POSTGRES_RESERVED_CONNECTIONS} reserved) — ` +
      `${ROLLOUT_GENERATIONS} generations of (${parts}), +${MIGRATION_CONNECTIONS} migrating`,
  ];
}
