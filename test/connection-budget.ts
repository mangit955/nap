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
 * **A rollout runs two copies of a process for a while.** The new pod is started before the old
 * one is stopped, and a draining worker keeps its connections for as long as its drain lasts,
 * which can outlive the deploys of the other two. So the peak is every replica's connections, plus
 * one more pod of each process, plus the migration the release runs first.
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

/** The most connections the deployment can hold at one moment. */
export function peakConnections(processes: DeployedProcess[]): number {
  const steady = processes.reduce((sum, p) => sum + p.replicas * p.connections, 0);
  const rollingOverlap = processes.reduce((sum, p) => sum + p.connections, 0);
  return steady + rollingOverlap + MIGRATION_CONNECTIONS;
}

/**
 * Empty when the deployment fits under `maxConnections`; otherwise one message saying by how much
 * and what each process contributes.
 */
export function connectionBudgetViolations(
  processes: DeployedProcess[],
  maxConnections: number,
): string[] {
  const usable = maxConnections - POSTGRES_RESERVED_CONNECTIONS;
  const peak = peakConnections(processes);
  if (peak <= usable) return [];

  const parts = processes
    .map((p) => `${p.name}: ${p.replicas} × ${p.connections} (+${p.connections} rolling)`)
    .join(", ");
  return [
    `can hold ${peak} connections at once, over the ${usable} the database allows ` +
      `(${maxConnections} less ${POSTGRES_RESERVED_CONNECTIONS} reserved) — ${parts}, ` +
      `+${MIGRATION_CONNECTIONS} migrating`,
  ];
}
