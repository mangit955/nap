/**
 * A `CapacityReconciler` that answers whatever a test told it to.
 *
 * Deliberately scripted rather than simulated. Both of the real rules are `where` clauses — past
 * an expiry, named by no project — and a fake that reimplemented them in JavaScript would agree
 * with itself about rows no database had ever been asked about. What the callers above need to be
 * tested for is different: that a sweep reports what came back, that it never destroys a sandbox
 * on a reference list it failed to read, and that one failure does not end the pass. All three
 * are about the *answers*, so answers are what this holds.
 *
 * The real rules are asserted against a real Postgres in `postgres-capacity-reconciler.db.test.ts`.
 */

import type { CapacityReconciler, ReclaimedCapacity } from "@nap/shared/ports/capacity-reconciler";

export type SeedReconciliation = {
  reclaimed?: Partial<ReclaimedCapacity>;
  /** Sandbox ids the database still points at. Empty means nothing is referenced by anything. */
  referenced?: string[];
  /**
   * Project ids this database has heard of. Undefined means *all of them* — most callers are
   * testing something else, and a fake that quietly knew no projects would make every sandbox
   * somebody else's and every destroy test pass for the wrong reason.
   */
  knownProjects?: string[];
};

export class InMemoryCapacityReconciler implements CapacityReconciler {
  #reclaimed: ReclaimedCapacity;
  #referenced: string[];
  #knownProjects: string[] | undefined;
  #reclaimFailure: Error | undefined;
  #referenceFailure: Error | undefined;
  #reclaimCalls = 0;

  constructor(seed: SeedReconciliation = {}) {
    this.#reclaimed = {
      expired: seed.reclaimed?.expired ?? [],
      orphaned: seed.reclaimed?.orphaned ?? [],
    };
    this.#referenced = seed.referenced ?? [];
    this.#knownProjects = seed.knownProjects;
  }

  /** Makes `reclaimStranded` throw until called again with `undefined` — a database not there. */
  failReclaimWith(error: Error | undefined): this {
    this.#reclaimFailure = error;
    return this;
  }

  /**
   * Makes only `referencedSandboxIds` throw.
   *
   * Separately from the above because they fail into different consequences: a reclamation that
   * did not happen costs a few minutes of capacity, while acting on a reference list that was
   * never read would destroy sandboxes that are perfectly healthy.
   */
  failReferencesWith(error: Error | undefined): this {
    this.#referenceFailure = error;
    return this;
  }

  /** How many passes have asked, which is how "the sweep still reconciles" is asserted. */
  reclaimCalls(): number {
    return this.#reclaimCalls;
  }

  async reclaimStranded(): Promise<ReclaimedCapacity> {
    this.#reclaimCalls += 1;
    if (this.#reclaimFailure !== undefined) throw this.#reclaimFailure;
    return { expired: [...this.#reclaimed.expired], orphaned: [...this.#reclaimed.orphaned] };
  }

  async referencedSandboxIds(): Promise<string[]> {
    if (this.#referenceFailure !== undefined) throw this.#referenceFailure;
    return [...this.#referenced];
  }

  async knownProjectIds(projectIds: string[]): Promise<string[]> {
    if (this.#referenceFailure !== undefined) throw this.#referenceFailure;

    const known = this.#knownProjects;
    return known === undefined ? [...projectIds] : projectIds.filter((id) => known.includes(id));
  }
}
