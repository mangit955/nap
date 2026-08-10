/**
 * A `ProjectStore` holding projects in a map.
 *
 * The routes above it are about status codes and shapes — a project that is not there is a
 * 404, one with a turn running is a 409 — and none of that needs a database to be true. This
 * keeps those tests to the thing they are testing.
 *
 * Ordering is applied on the way out rather than assumed from insertion order, because "most
 * recently active first" is a promise the port makes and a fake that happened to satisfy it by
 * accident would let a real store break it unnoticed.
 *
 * **It enforces ownership rather than accepting the user id and ignoring it.** That is the whole
 * value of it here: a fake that took the parameter and filtered on nothing would make every
 * authorization test in the suite pass against a store that hands a stranger somebody else's
 * project, which is precisely the bug those tests exist to catch.
 */

import type { ProjectStore, ProjectSummary } from "@nap/shared/ports/project-store";

/**
 * The owner a seeded project gets when a test does not care who it belongs to — which is most
 * of them, since they are about status codes. Tests that *are* about ownership name two users.
 */
export const FAKE_OWNER = "00000000-0000-4000-8000-000000000001";

/** A project plus who it belongs to; the owner is not part of the summary the API returns. */
export type OwnedProject = ProjectSummary & { userId?: string };

export class InMemoryProjectStore implements ProjectStore {
  readonly #projects = new Map<string, ProjectSummary & { userId: string }>();
  #failure: Error | undefined;
  #deleteFailure: Error | undefined;

  constructor(seed: OwnedProject[] = []) {
    for (const project of seed) this.put(project);
  }

  /** Makes every method fail until called again with `undefined`. */
  failWith(error: Error | undefined): this {
    this.#failure = error;
    return this;
  }

  /**
   * Makes only `delete` fail. Deleting a project reads it first, so a store that failed
   * everything could never reach the delete — and the interesting failure is the one that
   * happens after the objects have already been removed.
   */
  failDeleteWith(error: Error | undefined): this {
    this.#deleteFailure = error;
    return this;
  }

  /** Adds or replaces a project, so a test can set one up after construction. */
  put(project: OwnedProject): this {
    const { userId = FAKE_OWNER, ...summary } = project;
    this.#projects.set(project.projectId, { ...summary, userId });
    return this;
  }

  async list(userId: string): Promise<ProjectSummary[]> {
    this.#throwIfFailing();
    return [...this.#projects.values()]
      .filter((project) => project.userId === userId)
      .map(withoutOwner)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(projectId: string, userId: string): Promise<ProjectSummary | null> {
    this.#throwIfFailing();
    const found = this.#projects.get(projectId);
    // Somebody else's project is indistinguishable from one that is not here, exactly as the
    // real store's `where` clause makes it.
    if (found === undefined || found.userId !== userId) return null;
    return withoutOwner(found);
  }

  async delete(projectId: string, userId: string): Promise<boolean> {
    this.#throwIfFailing();
    if (this.#deleteFailure !== undefined) throw this.#deleteFailure;

    const found = this.#projects.get(projectId);
    if (found === undefined || found.userId !== userId) return false;
    return this.#projects.delete(projectId);
  }

  /**
   * Counted from the seeded projects rather than returned as a constant, for the same reason the
   * ownership filter above is real: a fake that answered `0` would make every quota test pass
   * against a check that never refuses anybody.
   */
  async countRunningSandboxes(userId?: string): Promise<number> {
    this.#throwIfFailing();
    return [...this.#projects.values()].filter(
      (project) =>
        project.sandboxId !== null && (userId === undefined || project.userId === userId),
    ).length;
  }

  #throwIfFailing(): void {
    // Thrown rather than returned, like the other stores here: a database that cannot be
    // reached is not an outcome these interfaces model.
    if (this.#failure !== undefined) throw this.#failure;
  }
}

function withoutOwner(project: ProjectSummary & { userId: string }): ProjectSummary {
  const { userId: _owner, ...summary } = project;
  return { ...summary };
}
