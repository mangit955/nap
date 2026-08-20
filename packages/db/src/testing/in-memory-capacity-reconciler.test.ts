import { describe, expect, it } from "vitest";
import { InMemoryCapacityReconciler } from "./in-memory-capacity-reconciler.ts";

/**
 * The fake every sweep test reconciles against, so its own behaviour has to be worth trusting —
 * particularly that its two failure switches fail apart, since a sweep is meant to survive one
 * and stop dead on the other.
 */
describe("InMemoryCapacityReconciler", () => {
  it("reports nothing reclaimed and nothing referenced by default", async () => {
    const reconciler = new InMemoryCapacityReconciler();

    expect(await reconciler.reclaimStranded()).toEqual({ expired: [], orphaned: [] });
    expect(await reconciler.referencedSandboxIds()).toEqual([]);
  });

  it("reports what it was seeded with, and counts the passes", async () => {
    const reconciler = new InMemoryCapacityReconciler({
      reclaimed: { expired: ["r1"], orphaned: ["r2"] },
      referenced: ["sbx-live"],
    });

    expect(await reconciler.reclaimStranded()).toEqual({ expired: ["r1"], orphaned: ["r2"] });
    expect(await reconciler.referencedSandboxIds()).toEqual(["sbx-live"]);
    expect(reconciler.reclaimCalls()).toBe(1);
  });

  it("hands back copies, so a caller cannot edit the next answer", async () => {
    const reconciler = new InMemoryCapacityReconciler({ referenced: ["sbx-live"] });

    (await reconciler.referencedSandboxIds()).push("sbx-invented");

    expect(await reconciler.referencedSandboxIds()).toEqual(["sbx-live"]);
  });

  it("fails reclamation without failing the reference read", async () => {
    const reconciler = new InMemoryCapacityReconciler({ referenced: ["sbx-live"] });
    reconciler.failReclaimWith(new Error("connection terminated"));

    await expect(reconciler.reclaimStranded()).rejects.toThrow("connection terminated");
    await expect(reconciler.referencedSandboxIds()).resolves.toEqual(["sbx-live"]);
  });

  it("fails the reference read without failing reclamation", async () => {
    const reconciler = new InMemoryCapacityReconciler();
    reconciler.failReferencesWith(new Error("connection terminated"));

    await expect(reconciler.referencedSandboxIds()).rejects.toThrow("connection terminated");
    await expect(reconciler.reclaimStranded()).resolves.toEqual({ expired: [], orphaned: [] });
  });
});
