import { InMemoryCapacityReconciler } from "@nap/db/testing/in-memory-capacity-reconciler";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { beforeEach, describe, expect, it } from "vitest";
import { reconcileCapacity } from "./reconcile-capacity.ts";

/**
 * The three ways a sandbox slot goes missing, and the pass that gets each of them back.
 *
 * Two of the three are a `delete` in Postgres and are asserted there; what is asserted here is
 * the third — a sandbox running at the provider that nothing in the database points at — and the
 * rules around ever destroying anything, which are the dangerous part. A sweep that got the
 * unreferenced set wrong destroys a workspace somebody is typing into.
 */

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);
const AN_HOUR_AGO = NOW - 60 * 60 * 1000;
const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";

let sandbox: InMemorySandboxManager;

beforeEach(() => {
  sandbox = new InMemorySandboxManager({ now: () => AN_HOUR_AGO });
});

/** A sandbox the provider is running, old enough not to be a creation in flight. */
async function running(projectId = PROJECT): Promise<string> {
  const created = await sandbox.create(projectId);
  if (!created.ok) throw new Error("could not create a sandbox");
  return created.value.id;
}

function reconcile(reconciler: InMemoryCapacityReconciler) {
  return reconcileCapacity({ reconciler, inventory: sandbox, sandbox, now: () => NOW });
}

describe("a sandbox nothing references", () => {
  it("is destroyed, because nothing else will ever find it", async () => {
    // The failure this exists for: the sandbox was created and the transaction recording it
    // failed, so it runs and is billed under an id that appears nowhere.
    const id = await running();

    const result = await reconcile(new InMemoryCapacityReconciler({ referenced: [] }));

    expect(result.destroyed).toEqual([id]);
    await expect(sandbox.resume(id)).resolves.toMatchObject({ error: { code: "destroyed" } });
  });

  it("is left alone as soon as anything does reference it", async () => {
    // Every healthy sandbox in the deployment is in this case, so getting it wrong destroys the
    // whole estate rather than one leak.
    const id = await running();

    const result = await reconcile(new InMemoryCapacityReconciler({ referenced: [id] }));

    expect(result.destroyed).toEqual([]);
    await expect(sandbox.resume(id)).resolves.toMatchObject({ ok: true });
  });

  it("is left alone while it is young enough to be a creation in flight", async () => {
    // A sandbox is created a moment before anything is written down about it. Without a grace
    // window this pass races every acquire in the cluster and wins some of them.
    sandbox = new InMemorySandboxManager({ now: () => NOW - 1000 });
    const id = await running();

    const result = await reconcile(new InMemoryCapacityReconciler({ referenced: [] }));

    expect(result.destroyed).toEqual([]);
    await expect(sandbox.resume(id)).resolves.toMatchObject({ ok: true });
  });

  it("is left alone when the provider says it belongs to no project of ours", async () => {
    // The E2B account may be shared with something else. A sandbox without our metadata was
    // made by that something else, and its absence from our database proves nothing at all.
    const id = await running();
    const inventory = {
      list: async () => ({
        ok: true as const,
        value: [{ id, projectId: null, startedAt: new Date(AN_HOUR_AGO).toISOString() }],
      }),
    };

    const result = await reconcileCapacity({
      reconciler: new InMemoryCapacityReconciler({ referenced: [] }),
      inventory,
      sandbox,
      now: () => NOW,
    });

    expect(result.destroyed).toEqual([]);
    await expect(sandbox.resume(id)).resolves.toMatchObject({ ok: true });
  });

  it("is left alone when this database has never heard of its project", async () => {
    // `bun run harness --real` and a funded NapBench run both create sandboxes on this same E2B
    // account, tagged with project ids that live in a throwaway database or in none. A deployed
    // reaper that destroyed everything it could not account for would kill them mid-run.
    const id = await running("11111111-2222-4333-8444-555555555555");

    const result = await reconcileCapacity({
      reconciler: new InMemoryCapacityReconciler({ referenced: [], knownProjects: [] }),
      inventory: sandbox,
      sandbox,
      now: () => NOW,
    });

    expect(result.destroyed).toEqual([]);
    await expect(sandbox.resume(id)).resolves.toMatchObject({ ok: true });
  });
});

describe("a creation that was never recorded", () => {
  it("heals both halves in one pass: the row goes back and the sandbox is destroyed", async () => {
    // The failure boundary itself, on the board rather than in pieces: the reservation was made,
    // the sandbox was created, and the write that would have named it never landed. The slot and
    // the machine are two separate leaks and this is the only thing that gets either back.
    const id = await running();
    const reconciler = new InMemoryCapacityReconciler({
      reclaimed: { expired: ["r-never-activated"] },
      referenced: [],
    });

    const result = await reconcile(reconciler);

    expect(result.expired).toEqual(["r-never-activated"]);
    expect(result.destroyed).toEqual([id]);
    await expect(sandbox.resume(id)).resolves.toMatchObject({ error: { code: "destroyed" } });
  });
});

describe("the rows nothing gave back", () => {
  it("reports what the database reclaimed, apart", async () => {
    const capacity = new InMemoryCapacityReconciler({
      reclaimed: { expired: ["r-died-mid-creation"], orphaned: ["r-sandbox-vanished"] },
    });

    const result = await reconcile(capacity);

    expect(result.expired).toEqual(["r-died-mid-creation"]);
    expect(result.orphaned).toEqual(["r-sandbox-vanished"]);
  });

  it("reclaims before it looks at the provider", async () => {
    // Order matters: reclaiming first is what makes a stranded row's sandbox visible as
    // unreferenced in the same pass, rather than a tick later.
    const capacity = new InMemoryCapacityReconciler();

    await reconcile(capacity);

    expect(capacity.reclaimCalls()).toBe(1);
  });
});

describe("when something goes wrong", () => {
  it("still reclaims rows when the provider cannot be listed", async () => {
    // The two halves fail independently — one is Postgres, the other is E2B — and the cheap,
    // safe half must not be held hostage by the expensive one.
    const capacity = new InMemoryCapacityReconciler({ reclaimed: { expired: ["r-expired"] } });
    const result = await reconcileCapacity({
      reconciler: capacity,
      inventory: { list: async () => ({ ok: false as const, error: unavailable() }) },
      sandbox,
      now: () => NOW,
    });

    expect(result.expired).toEqual(["r-expired"]);
    expect(result.failed).toMatchObject([{ step: "list" }]);
  });

  it("destroys nothing when the reference list could not be read", async () => {
    // Emphatically not "destroy what is missing from the empty set": a database that is down
    // would otherwise take the whole estate with it.
    const id = await running();
    const capacity = new InMemoryCapacityReconciler().failReferencesWith(
      new Error("connection terminated"),
    );

    const result = await reconcile(capacity);

    expect(result.destroyed).toEqual([]);
    expect(result.failed).toMatchObject([{ step: "references" }]);
    await expect(sandbox.resume(id)).resolves.toMatchObject({ ok: true });
  });

  it("destroys nothing when it could not ask which projects are ours", async () => {
    // Same rule as the reference set, and for the same reason: every question this pass asks
    // Postgres can only ever *stop* a destroy, so failing to ask must stop it too.
    const id = await running();
    const reconciler = new InMemoryCapacityReconciler({ referenced: [] });
    reconciler.failReferencesWith(undefined);

    const result = await reconcileCapacity({
      reconciler: {
        reclaimStranded: () => reconciler.reclaimStranded(),
        referencedSandboxIds: () => reconciler.referencedSandboxIds(),
        knownProjectIds: () => Promise.reject(new Error("connection terminated")),
      },
      inventory: sandbox,
      sandbox,
      now: () => NOW,
    });

    expect(result.destroyed).toEqual([]);
    expect(result.failed).toMatchObject([{ step: "projects" }]);
    await expect(sandbox.resume(id)).resolves.toMatchObject({ ok: true });
  });

  it("carries on with the provider when reclamation failed", async () => {
    const id = await running();
    const capacity = new InMemoryCapacityReconciler({ referenced: [] }).failReclaimWith(
      new Error("connection terminated"),
    );

    const result = await reconcile(capacity);

    expect(result.failed).toMatchObject([{ step: "reclaim" }]);
    expect(result.destroyed).toEqual([id]);
  });

  it("carries on with the rest after one sandbox cannot be destroyed", async () => {
    // The same rule the sweep above it follows: the one that failed is the one most likely to
    // fail again, and every other leak is still costing money in the meantime.
    const stubborn = await running();
    const second = await running("6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e");

    const result = await reconcileCapacity({
      reconciler: new InMemoryCapacityReconciler({ referenced: [] }),
      inventory: sandbox,
      sandbox: {
        destroy: async (id: string) =>
          id === stubborn
            ? { ok: false as const, error: unavailable() }
            : await sandbox.destroy(id),
      },
      now: () => NOW,
    });

    expect(result.destroyed).toEqual([second]);
    expect(result.failed).toMatchObject([{ step: "destroy", sandboxId: stubborn }]);
  });
});

function unavailable() {
  return { code: "unavailable" as const, message: "E2B is not answering" };
}
