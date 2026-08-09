import type { ProjectSummary } from "@nap/shared/ports/project-store";
import { describe, expect, it } from "vitest";
import { InMemoryProjectStore } from "./in-memory-project-store.ts";

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    projectId: "p1",
    name: "Todo app",
    status: "idle",
    sandboxId: null,
    updatedAt: "2026-08-09T11:00:00.000Z",
    sessionIds: ["s1"],
    ...overrides,
  };
}

describe("listing", () => {
  it("puts the most recently active project first", async () => {
    // What the list page is for: the thing you were just working on is the thing you want.
    const store = new InMemoryProjectStore([
      project({ projectId: "older", updatedAt: "2026-08-09T10:00:00.000Z" }),
      project({ projectId: "newer", updatedAt: "2026-08-09T12:00:00.000Z" }),
    ]);

    const listed = await store.list();

    expect(listed.map((p) => p.projectId)).toEqual(["newer", "older"]);
  });

  it("hands back copies, so a caller cannot edit the store by accident", async () => {
    const store = new InMemoryProjectStore([project()]);

    const [first] = await store.list();
    if (first === undefined) throw new Error("expected a project");
    first.name = "renamed";

    expect((await store.get("p1"))?.name).toBe("Todo app");
  });
});

describe("get", () => {
  it("is null for a project that does not exist", async () => {
    await expect(new InMemoryProjectStore().get("nope")).resolves.toBeNull();
  });
});

describe("delete", () => {
  it("reports having deleted a project that was there", async () => {
    const store = new InMemoryProjectStore([project()]);

    await expect(store.delete("p1")).resolves.toBe(true);
    await expect(store.get("p1")).resolves.toBeNull();
  });

  it("reports false rather than failing when there was nothing to delete", async () => {
    // Two clicks on the same button, or two tabs. The second one is finding out the row is
    // already gone, which is what it wanted.
    await expect(new InMemoryProjectStore().delete("nope")).resolves.toBe(false);
  });
});

describe("failure injection", () => {
  it("fails every method on demand, so a caller's error path can be driven", async () => {
    const store = new InMemoryProjectStore([project()]).failWith(new Error("connection dropped"));

    await expect(store.list()).rejects.toThrow(/connection dropped/);
    await expect(store.get("p1")).rejects.toThrow(/connection dropped/);
    await expect(store.delete("p1")).rejects.toThrow(/connection dropped/);
  });

  it("fails only the delete when asked, since reading comes first", async () => {
    const store = new InMemoryProjectStore([project()]).failDeleteWith(new Error("no write"));

    await expect(store.get("p1")).resolves.not.toBeNull();
    await expect(store.delete("p1")).rejects.toThrow(/no write/);
  });
});
