/**
 * Making the sandbox ceiling self-healing, once per sweep.
 *
 * Capacity is claimed before a sandbox is created and released when it is destroyed, which covers
 * every path that runs to the end. Three do not, and each of them leaks a slot of the only limit
 * bounding this deployment's E2B bill:
 *
 *  - **A process dies after reserving, before creating.** The row holds a slot nothing will ever
 *    release. Reclaimed once its expiry has passed, so the cost is bounded by that window rather
 *    than being permanent.
 *  - **Creation succeeds and recording it fails.** A sandbox that exists, is billed, and is named
 *    nowhere in the database — the one case that cannot be found from the database at all, and
 *    the reason this asks the provider what it is running.
 *  - **A sandbox is destroyed out of band**, by the provider's own timer. The row outlives the
 *    thing it names.
 *
 * The first and third are two `delete`s behind `CapacityReconciler`. The second boundary is the
 * one with teeth, because it is the only thing here that destroys, and three guards on it are what
 * most of this file is. **A sandbox is destroyed only when the reference set was read
 * successfully**, so a database outage is never mistaken for an empty estate. **Only when it is
 * old enough not to be a creation in flight**, since a sandbox exists for a moment before anything
 * is written down about it. And **only when this database knows the project it was created for** —
 * a real harness run and a funded benchmark both make sandboxes on the same E2B account against a
 * database this deployment has never seen, and destroying those mid-run is a mistake nothing can
 * undo.
 *
 * Nothing here throws and nothing here stops early on one failure, for the reason the sweep it
 * runs inside does not: the leaks it did not get to are still costing money, and the one that
 * failed is the one most likely to fail again next tick.
 */

import { STRANDED_GRACE_MS } from "@nap/shared/capacity-windows";
import type { CapacityReconciler } from "@nap/shared/ports/capacity-reconciler";
import type { SandboxInventory } from "@nap/shared/ports/sandbox-inventory";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";

export type ReconcileFailure = {
  /** Which part gave up, so a log line says whether Postgres or the provider is unhappy. */
  step: "reclaim" | "references" | "list" | "projects" | "destroy";
  /** Present only for a `destroy`, which is the only step about one sandbox in particular. */
  sandboxId?: string;
  message: string;
};

export type ReconcileResult = {
  /** Reservations deleted because a process died between reserving and creating. */
  expired: string[];
  /** Reservations deleted because nothing names their sandbox any more. */
  orphaned: string[];
  /** Sandboxes destroyed at the provider because nothing in the database referenced them. */
  destroyed: string[];
  failed: ReconcileFailure[];
};

export type ReconcileOptions = {
  /** Where the stranded rows are reclaimed, and where the reference set is read from. */
  reconciler: CapacityReconciler;
  /** What the provider says it is running — the only place an unreferenced sandbox appears. */
  inventory: SandboxInventory;
  /**
   * Just the destroy: this decides *which* sandboxes are leaks and nothing else about them.
   *
   * Narrowed rather than taking the whole manager so that the one dangerous capability it needs
   * is the only one it holds.
   */
  sandbox: Pick<SandboxManager, "destroy">;
  /** Injected so a test can place "an hour ago" exactly rather than waiting for one. */
  now?: () => number;
};

export async function reconcileCapacity(options: ReconcileOptions): Promise<ReconcileResult> {
  const now = options.now ?? Date.now;
  const result: ReconcileResult = { expired: [], orphaned: [], destroyed: [], failed: [] };

  // First, because a stranded row's sandbox only becomes visible as unreferenced once the row
  // holding its id is gone — doing it the other way round would find each leak a tick late.
  try {
    const reclaimed = await options.reconciler.reclaimStranded();
    result.expired = reclaimed.expired;
    result.orphaned = reclaimed.orphaned;
  } catch (error) {
    result.failed.push({ step: "reclaim", message: messageOf(error) });
  }

  let referenced: Set<string>;
  try {
    referenced = new Set(await options.reconciler.referencedSandboxIds());
  } catch (error) {
    // Returning rather than carrying on with what was read: everything below destroys what is
    // *missing* from this set, so a partial or absent answer reads as "nothing is referenced"
    // and would take the entire estate with it.
    result.failed.push({ step: "references", message: messageOf(error) });
    return result;
  }

  const listed = await options.inventory.list();
  if (!listed.ok) {
    result.failed.push({ step: "list", message: listed.error.message });
    return result;
  }

  // Shared with the rule that reclaims an `active` row, so the two agree about which acquires
  // are still in flight — see `@nap/shared/capacity-windows`.
  const oldest = now() - STRANDED_GRACE_MS;

  // Everything still standing after the cheap, local rules: unreferenced, ours by metadata, and
  // old enough to be a leak rather than an acquire in flight.
  const suspects = listed.value.filter(
    (sandbox) =>
      // Null means nothing here created it, so its absence from our tables says nothing at all.
      // The account may be shared, and destroying somebody else's machine cannot be undone.
      sandbox.projectId !== null &&
      !referenced.has(sandbox.id) &&
      Date.parse(sandbox.startedAt) <= oldest,
  );

  // Nothing to ask about, and a query per tick forever is what the healthy case would otherwise
  // cost.
  if (suspects.length === 0) return result;

  // One question for all of them, and the last thing standing between a `--real` harness run and
  // a deployed reaper: a sandbox tagged with a project this database has never heard of belongs
  // to a throwaway database somewhere else. A failure to ask is a failure to destroy, for the
  // same reason the reference set is.
  let known: Set<string>;
  try {
    known = new Set(
      await options.reconciler.knownProjectIds([
        ...new Set(suspects.map((sandbox) => sandbox.projectId ?? "")),
      ]),
    );
  } catch (error) {
    result.failed.push({ step: "projects", message: messageOf(error) });
    return result;
  }

  for (const sandbox of suspects) {
    if (sandbox.projectId === null || !known.has(sandbox.projectId)) continue;

    const destroyed = await options.sandbox.destroy(sandbox.id);
    if (destroyed.ok) result.destroyed.push(sandbox.id);
    else {
      result.failed.push({
        step: "destroy",
        sandboxId: sandbox.id,
        message: destroyed.error.message,
      });
    }
  }

  return result;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
