import { describe, expect, it } from "vitest";
import { InMemorySnapshotStore } from "./in-memory-snapshot-store.ts";

const PROJECT = "project-1";
const OTHER = "project-2";

describe("record", () => {
  it("hands back the row it wrote", async () => {
    const store = new InMemorySnapshotStore();

    const row = await store.record({ projectId: PROJECT, key: "k", gitSha: "abc" });

    expect(row).toMatchObject({ projectId: PROJECT, key: "k", gitSha: "abc" });
    expect(row.id).toEqual(expect.any(String));
  });

  it("keeps every row, in the order they were written", async () => {
    const store = new InMemorySnapshotStore();

    await store.record({ projectId: PROJECT, key: "one", gitSha: "aaa" });
    await store.record({ projectId: PROJECT, key: "two", gitSha: "bbb" });

    expect(store.all().map((row) => row.key)).toEqual(["one", "two"]);
  });

  it("throws when told to fail", async () => {
    // The row write failing is its own case: the bytes are already uploaded, and destroying
    // the sandbox now would strand them with nothing pointing at the project.
    const store = new InMemorySnapshotStore().failWith(new Error("database is down"));

    await expect(store.record({ projectId: PROJECT, key: "k", gitSha: "a" })).rejects.toThrow(
      /database is down/,
    );
  });

  it("writes nothing while failing", async () => {
    const store = new InMemorySnapshotStore().failWith(new Error("down"));
    await store.record({ projectId: PROJECT, key: "k", gitSha: "a" }).catch(() => {});

    expect(store.all()).toEqual([]);
  });
});

describe("latestFor", () => {
  it("is the most recent row for that project", async () => {
    const store = new InMemorySnapshotStore();
    await store.record({ projectId: PROJECT, key: "older", gitSha: "aaa" });
    await store.record({ projectId: PROJECT, key: "newer", gitSha: "bbb" });

    await expect(store.latestFor(PROJECT)).resolves.toMatchObject({ key: "newer" });
  });

  it("ignores other projects", async () => {
    const store = new InMemorySnapshotStore();
    await store.record({ projectId: PROJECT, key: "mine", gitSha: "aaa" });
    await store.record({ projectId: OTHER, key: "theirs", gitSha: "bbb" });

    await expect(store.latestFor(PROJECT)).resolves.toMatchObject({ key: "mine" });
  });

  it("is null when the project has never been torn down", async () => {
    await expect(new InMemorySnapshotStore().latestFor(PROJECT)).resolves.toBeNull();
  });
});

describe("listFor", () => {
  it("is newest first, matching the real store", async () => {
    const store = new InMemorySnapshotStore();
    await store.record({ projectId: PROJECT, key: "older", gitSha: "aaa" });
    await store.record({ projectId: PROJECT, key: "newer", gitSha: "bbb" });

    expect((await store.listFor(PROJECT)).map((row) => row.key)).toEqual(["newer", "older"]);
  });

  it("only lists that project's rows", async () => {
    const store = new InMemorySnapshotStore();
    await store.record({ projectId: PROJECT, key: "mine", gitSha: "aaa" });
    await store.record({ projectId: OTHER, key: "theirs", gitSha: "bbb" });

    expect((await store.listFor(PROJECT)).map((row) => row.key)).toEqual(["mine"]);
  });
});

describe("timestamps", () => {
  it("increase with every row, so ordering never depends on clock resolution", async () => {
    // Two teardowns in the same millisecond are ordinary. If this fake used `Date.now()`,
    // "the newest" would be ambiguous here while the Postgres store answers deterministically.
    const store = new InMemorySnapshotStore();
    const first = await store.record({ projectId: PROJECT, key: "a", gitSha: "aaa" });
    const second = await store.record({ projectId: PROJECT, key: "b", gitSha: "bbb" });

    expect(second.createdAt > first.createdAt).toBe(true);
  });
});
