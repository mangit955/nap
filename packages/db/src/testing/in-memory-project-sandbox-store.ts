/**
 * A `ProjectSandboxStore` holding projects in a map.
 *
 * The reaper's whole behaviour is a function of what this returns and what it records, so the
 * fake is seeded with projects and their last activity directly: "idle for an hour", "active a
 * second ago" and "has no sandbox" are each one line, which is what makes the sweep's rules
 * testable without a database or a clock.
 *
 * `activityAt` is a timestamp a test sets rather than one this derives, because the real store
 * derives it from the event log and a fake that faked the log too would be testing itself.
 */

import {
  type IdleProject,
  type ProjectSandboxStore,
  VIEWER_SIGNAL_INTERVAL_MS,
} from "@nap/shared/ports/project-sandbox-store";

export type SeedProject = {
  projectId: string;
  /** Null means the project holds no sandbox, so it can never be a candidate. */
  sandboxId?: string | null;
  sessionIds?: string[];
  /** Where this project's bytes already are, if it has been put away before. */
  snapshotKey?: string;
  /** When this project last did anything, as an ISO string. */
  lastActiveAt: string;
  /** When a viewer last signalled, as an ISO string. Absent means nobody has. */
  viewedAt?: string;
};

type ProjectRow = {
  projectId: string;
  sandboxId: string | null;
  sessionIds: string[];
  lastActiveAt: string;
  viewedAt: string | null;
  snapshotKey: string | null;
};

export type InMemoryProjectSandboxStoreOptions = {
  /** The clock `recordViewer` stamps and throttles by, so a test can cross the minute exactly. */
  now?: () => number;
};

export class InMemoryProjectSandboxStore implements ProjectSandboxStore {
  readonly #projects = new Map<string, ProjectRow>();
  readonly #now: () => number;
  #failure: Error | undefined;

  constructor(seed: SeedProject[] = [], options: InMemoryProjectSandboxStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    for (const project of seed) {
      this.#projects.set(project.projectId, {
        projectId: project.projectId,
        sandboxId: project.sandboxId ?? null,
        sessionIds: project.sessionIds ?? [],
        lastActiveAt: project.lastActiveAt,
        viewedAt: project.viewedAt ?? null,
        snapshotKey: project.snapshotKey ?? null,
      });
    }
  }

  /** Makes `releaseSandbox` fail until called again with `undefined`. */
  failWith(error: Error | undefined): this {
    this.#failure = error;
    return this;
  }

  /** What a project looks like now — the assertion surface for "was it released?". */
  get(projectId: string): ProjectRow | undefined {
    const row = this.#projects.get(projectId);
    return row === undefined ? undefined : { ...row };
  }

  /** Moves a project's last activity, which is how a test says someone was still working. */
  touch(projectId: string, at: string): this {
    const row = this.#projects.get(projectId);
    if (row !== undefined) this.#projects.set(projectId, { ...row, lastActiveAt: at });
    return this;
  }

  async idleSince(cutoff: string): Promise<IdleProject[]> {
    const idle: IdleProject[] = [];

    for (const row of this.#projects.values()) {
      if (row.sandboxId === null) continue;
      if (row.lastActiveAt >= cutoff) continue;

      idle.push({
        projectId: row.projectId,
        sandboxId: row.sandboxId,
        sessionIds: [...row.sessionIds],
        lastActiveAt: row.lastActiveAt,
        viewedAt: row.viewedAt,
      });
    }

    return idle;
  }

  async recordViewer(sessionId: string): Promise<void> {
    const now = this.#now();
    for (const row of this.#projects.values()) {
      if (!row.sessionIds.includes(sessionId)) continue;
      // The same three conditions as the real statement's `where`: see the port.
      if (row.sandboxId === null) return;
      if (row.viewedAt !== null && Date.parse(row.viewedAt) >= now - VIEWER_SIGNAL_INTERVAL_MS)
        return;
      this.#projects.set(row.projectId, { ...row, viewedAt: new Date(now).toISOString() });
      return;
    }
  }

  /** Names a machine on the project, as a turn does once it has created one. */
  recordSandbox(projectId: string, sandboxId: string): this {
    const row = this.#projects.get(projectId);
    if (row !== undefined) this.#projects.set(projectId, { ...row, sandboxId });
    return this;
  }

  async releaseSandbox(
    projectId: string,
    sandboxId: string,
    snapshotKey: string | null,
  ): Promise<boolean> {
    // Thrown rather than returned, like the other stores: a database that cannot be reached
    // is not an outcome this interface models.
    if (this.#failure !== undefined) throw this.#failure;

    const row = this.#projects.get(projectId);
    if (row === undefined) throw new Error(`unknown project ${projectId}`);
    // The project has moved on to another machine since the caller read it. See the port.
    if (row.sandboxId !== sandboxId) return false;

    this.#projects.set(projectId, {
      ...row,
      sandboxId: null,
      // Null leaves whatever was recorded: it means "nothing new was captured", not "there
      // is nothing".
      snapshotKey: snapshotKey ?? row.snapshotKey,
    });
    return true;
  }
}
