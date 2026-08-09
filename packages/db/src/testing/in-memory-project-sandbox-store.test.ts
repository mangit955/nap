import { describe, expect, it } from "vitest";
import { InMemoryProjectSandboxStore } from "./in-memory-project-sandbox-store.ts";

const OLD = "2026-08-09T11:00:00.000Z";
const RECENT = "2026-08-09T11:59:00.000Z";
const CUTOFF = "2026-08-09T11:50:00.000Z";

describe("finding idle projects", () => {
  it("returns a project whose last activity is older than the cutoff", async () => {
    const store = new InMemoryProjectSandboxStore([
      { projectId: "p1", sandboxId: "sb1", sessionIds: ["s1"], lastActiveAt: OLD },
    ]);

    await expect(store.idleSince(CUTOFF)).resolves.toEqual([
      { projectId: "p1", sandboxId: "sb1", sessionIds: ["s1"], lastActiveAt: OLD },
    ]);
  });

  it("leaves a project that was active inside the window alone", async () => {
    const store = new InMemoryProjectSandboxStore([
      { projectId: "p1", sandboxId: "sb1", lastActiveAt: RECENT },
    ]);

    await expect(store.idleSince(CUTOFF)).resolves.toEqual([]);
  });

  it("never offers a project that holds no sandbox", async () => {
    // There is nothing to reap, and destroying nothing would still write a snapshot row.
    const store = new InMemoryProjectSandboxStore([{ projectId: "p1", lastActiveAt: OLD }]);

    await expect(store.idleSince(CUTOFF)).resolves.toEqual([]);
  });

  it("sees activity recorded after it was seeded", async () => {
    const store = new InMemoryProjectSandboxStore([
      { projectId: "p1", sandboxId: "sb1", lastActiveAt: OLD },
    ]);

    store.touch("p1", RECENT);

    await expect(store.idleSince(CUTOFF)).resolves.toEqual([]);
  });
});

describe("releasing a sandbox", () => {
  it("clears the sandbox and records where the bytes went", async () => {
    const store = new InMemoryProjectSandboxStore([
      { projectId: "p1", sandboxId: "sb1", lastActiveAt: OLD },
    ]);

    await store.releaseSandbox("p1", "projects/p1/1-abc.bundle");

    expect(store.get("p1")).toMatchObject({
      sandboxId: null,
      snapshotKey: "projects/p1/1-abc.bundle",
    });
    // And it is no longer a candidate, because there is nothing left to reap.
    await expect(store.idleSince(CUTOFF)).resolves.toEqual([]);
  });

  it("leaves the recorded snapshot alone when there is no new one", async () => {
    // A sandbox reclaimed before it could be snapshotted still has to be let go of, and the
    // key already there may point at the last surviving copy of the project.
    const store = new InMemoryProjectSandboxStore([
      {
        projectId: "p1",
        sandboxId: "sb1",
        snapshotKey: "projects/p1/earlier.bundle",
        lastActiveAt: OLD,
      },
    ]);

    await store.releaseSandbox("p1", null);

    expect(store.get("p1")).toMatchObject({
      sandboxId: null,
      snapshotKey: "projects/p1/earlier.bundle",
    });
  });

  it("throws for a project that does not exist", async () => {
    const store = new InMemoryProjectSandboxStore();

    await expect(store.releaseSandbox("nope", "k")).rejects.toThrow(/unknown project/);
  });

  it("fails on demand, so a caller's recovery path can be driven", async () => {
    const store = new InMemoryProjectSandboxStore([
      { projectId: "p1", sandboxId: "sb1", lastActiveAt: OLD },
    ]).failWith(new Error("connection terminated"));

    await expect(store.releaseSandbox("p1", "k")).rejects.toThrow(/connection terminated/);
    // Nothing was recorded, so the sweep can try again next time round.
    expect(store.get("p1")?.sandboxId).toBe("sb1");
  });
});
