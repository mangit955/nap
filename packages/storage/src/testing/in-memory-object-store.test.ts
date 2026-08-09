import { describe, expect, it } from "vitest";
import { InMemoryObjectStore } from "./in-memory-object-store.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

describe("put and get", () => {
  it("returns what was stored", async () => {
    const store = new InMemoryObjectStore();

    await store.put("projects/p1/abc.bundle", bytes("PACK"));
    const found = await store.get("projects/p1/abc.bundle");

    expect(found.ok && text(found.value)).toBe("PACK");
  });

  it("reports a key that was never written", async () => {
    const store = new InMemoryObjectStore();

    expect(await store.get("nope")).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("replaces an object written twice", async () => {
    const store = new InMemoryObjectStore();

    await store.put("k", bytes("first"));
    await store.put("k", bytes("second"));
    const found = await store.get("k");

    expect(found.ok && text(found.value)).toBe("second");
  });

  it("copies what it is given, so a caller reusing its buffer cannot corrupt the store", async () => {
    // A bundle arrives as a `Uint8Array` the caller may well write over. A real store has
    // already serialized the bytes by the time `put` resolves, and a fake that aliases them
    // would let a test pass against code that could not work against R2.
    const store = new InMemoryObjectStore();
    const buffer = bytes("original");

    await store.put("k", buffer);
    buffer.fill(0);

    const found = await store.get("k");
    expect(found.ok && text(found.value)).toBe("original");
  });

  it("copies what it hands back, for the same reason", async () => {
    const store = new InMemoryObjectStore();
    await store.put("k", bytes("original"));

    const first = await store.get("k");
    if (first.ok) first.value.fill(0);

    const second = await store.get("k");
    expect(second.ok && text(second.value)).toBe("original");
  });
});

describe("delete", () => {
  it("removes the object", async () => {
    const store = new InMemoryObjectStore();
    await store.put("k", bytes("x"));

    await store.delete("k");

    expect(await store.get("k")).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("succeeds on a key that is not there", async () => {
    // Deleting a project must not fail because one of its snapshots was already cleaned up.
    // The port says so, and every adapter has to agree.
    const store = new InMemoryObjectStore();

    expect(await store.delete("never-existed")).toMatchObject({ ok: true });
  });
});

describe("driving failures", () => {
  it("fails every operation while the store is unavailable", async () => {
    // What the data-loss guard is tested against: an upload that fails must not be followed
    // by a destroyed sandbox.
    const store = new InMemoryObjectStore();
    store.failWith({ code: "unavailable", message: "R2 is down" });

    expect(await store.put("k", bytes("x"))).toMatchObject({ ok: false });
    expect(await store.get("k")).toMatchObject({ ok: false });
    expect(await store.delete("k")).toMatchObject({ ok: false });
  });

  it("recovers when the failure is cleared", async () => {
    const store = new InMemoryObjectStore();
    store.failWith({ code: "unavailable", message: "R2 is down" });
    store.failWith(undefined);

    expect(await store.put("k", bytes("x"))).toMatchObject({ ok: true });
  });

  it("stores nothing while failing", async () => {
    const store = new InMemoryObjectStore();
    store.failWith({ code: "unavailable", message: "R2 is down" });
    await store.put("k", bytes("x"));
    store.failWith(undefined);

    expect(await store.get("k")).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("inspecting what happened", () => {
  it("lists the keys it holds", async () => {
    const store = new InMemoryObjectStore();
    await store.put("b", bytes("2"));
    await store.put("a", bytes("1"));

    expect(store.keys()).toEqual(["a", "b"]);
  });

  it("counts uploads, including ones that replaced an object", async () => {
    // "Exactly one upload per teardown" is an assertion the snapshot tests need, and it
    // cannot be made from the key list alone.
    const store = new InMemoryObjectStore();
    await store.put("k", bytes("1"));
    await store.put("k", bytes("2"));

    expect(store.puts).toBe(2);
  });
});
