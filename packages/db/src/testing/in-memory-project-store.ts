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
 */

import type { ProjectStore, ProjectSummary } from "@nap/shared/ports/project-store";

export class InMemoryProjectStore implements ProjectStore {
  readonly #projects = new Map<string, ProjectSummary>();
  #failure: Error | undefined;
  #deleteFailure: Error | undefined;

  constructor(seed: ProjectSummary[] = []) {
    for (const project of seed) this.#projects.set(project.projectId, { ...project });
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
  put(project: ProjectSummary): this {
    this.#projects.set(project.projectId, { ...project });
    return this;
  }

  async list(): Promise<ProjectSummary[]> {
    this.#throwIfFailing();
    return [...this.#projects.values()]
      .map((project) => ({ ...project }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(projectId: string): Promise<ProjectSummary | null> {
    this.#throwIfFailing();
    const found = this.#projects.get(projectId);
    return found === undefined ? null : { ...found };
  }

  async delete(projectId: string): Promise<boolean> {
    this.#throwIfFailing();
    if (this.#deleteFailure !== undefined) throw this.#deleteFailure;
    return this.#projects.delete(projectId);
  }

  #throwIfFailing(): void {
    // Thrown rather than returned, like the other stores here: a database that cannot be
    // reached is not an outcome these interfaces model.
    if (this.#failure !== undefined) throw this.#failure;
  }
}
