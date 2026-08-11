import type { ProjectSummary } from "@nap/shared/ports/project-store";
import { describe, expect, it } from "vitest";
import { FAKE_OWNER, InMemoryProjectStore } from "./in-memory-project-store.ts";

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

    const listed = await store.list(FAKE_OWNER);

    expect(listed.map((p) => p.projectId)).toEqual(["newer", "older"]);
  });

  it("hands back copies, so a caller cannot edit the store by accident", async () => {
    const store = new InMemoryProjectStore([project()]);

    const [first] = await store.list(FAKE_OWNER);
    if (first === undefined) throw new Error("expected a project");
    first.name = "renamed";

    expect((await store.get("p1", FAKE_OWNER))?.name).toBe("Todo app");
  });
});

describe("get", () => {
  it("is null for a project that does not exist", async () => {
    await expect(new InMemoryProjectStore().get("nope", FAKE_OWNER)).resolves.toBeNull();
  });
});

describe("delete", () => {
  it("reports having deleted a project that was there", async () => {
    const store = new InMemoryProjectStore([project()]);

    await expect(store.delete("p1", FAKE_OWNER)).resolves.toBe(true);
    await expect(store.get("p1", FAKE_OWNER)).resolves.toBeNull();
  });

  it("reports false rather than failing when there was nothing to delete", async () => {
    // Two clicks on the same button, or two tabs. The second one is finding out the row is
    // already gone, which is what it wanted.
    await expect(new InMemoryProjectStore().delete("nope", FAKE_OWNER)).resolves.toBe(false);
  });
});

describe("failure injection", () => {
  it("fails every method on demand, so a caller's error path can be driven", async () => {
    const store = new InMemoryProjectStore([project()]).failWith(new Error("connection dropped"));

    await expect(store.list(FAKE_OWNER)).rejects.toThrow(/connection dropped/);
    await expect(store.get("p1", FAKE_OWNER)).rejects.toThrow(/connection dropped/);
    await expect(store.delete("p1", FAKE_OWNER)).rejects.toThrow(/connection dropped/);
  });

  it("fails only the delete when asked, since reading comes first", async () => {
    const store = new InMemoryProjectStore([project()]).failDeleteWith(new Error("no write"));

    await expect(store.get("p1", FAKE_OWNER)).resolves.not.toBeNull();
    await expect(store.delete("p1", FAKE_OWNER)).rejects.toThrow(/no write/);
  });
});

describe("ownership", () => {
  const OTHER = "00000000-0000-4000-8000-0000000000ff";

  it("lists only the asking user's projects", async () => {
    // The fake enforces this rather than accepting the id and ignoring it. A fake that ignored
    // it would make every authorization test above it pass against a store that leaks.
    const store = new InMemoryProjectStore([
      project({ projectId: "mine" }),
      { ...project({ projectId: "theirs" }), userId: OTHER },
    ]);

    expect((await store.list(FAKE_OWNER)).map((p) => p.projectId)).toEqual(["mine"]);
    expect((await store.list(OTHER)).map((p) => p.projectId)).toEqual(["theirs"]);
  });

  it("reports somebody else's project as absent rather than forbidden", async () => {
    const store = new InMemoryProjectStore([project()]);

    await expect(store.get("p1", OTHER)).resolves.toBeNull();
  });

  it("refuses to delete somebody else's project, and leaves it there", async () => {
    const store = new InMemoryProjectStore([project()]);

    await expect(store.delete("p1", OTHER)).resolves.toBe(false);
    await expect(store.get("p1", FAKE_OWNER)).resolves.not.toBeNull();
  });
});
