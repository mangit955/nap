import { NoSuchKey } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { type R2Client, R2ObjectStore, r2Endpoint } from "./r2-object-store.ts";

const KEY = "projects/p1/1735689600000-abc.bundle";
const BYTES = new TextEncoder().encode("PACK-bundle-bytes");

/** A client whose every method does whatever the test says, and records what it was given. */
function client(overrides: Partial<R2Client> = {}): R2Client & { calls: [string, string][] } {
  const calls: [string, string][] = [];
  return {
    calls,
    async put(key) {
      calls.push(["put", key]);
    },
    async get(key) {
      calls.push(["get", key]);
      return BYTES;
    },
    async delete(key) {
      calls.push(["delete", key]);
    },
    ...overrides,
  };
}

/** What the SDK throws when the bucket, the credentials or the network are the problem. */
function serviceError(name: string, status: number): Error {
  const error = new Error(`${name}: something went wrong`);
  error.name = name;
  Object.assign(error, { $metadata: { httpStatusCode: status } });
  return error;
}

describe("the R2 endpoint", () => {
  it("is composed from the account id", () => {
    // Getting this wrong is a boot that resolves, connects to nothing, and reports timeouts.
    expect(r2Endpoint("0123456789abcdef")).toBe(
      "https://0123456789abcdef.r2.cloudflarestorage.com",
    );
  });
});

describe("putting an object", () => {
  it("stores the bytes under the key", async () => {
    const c = client();

    const result = await new R2ObjectStore(c).put(KEY, BYTES);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(c.calls).toEqual([["put", KEY]]);
  });

  it("reports a refused upload rather than throwing it", async () => {
    // Teardown checks this result before it destroys a sandbox. A throw here would escape
    // that check and take the project with it.
    const c = client({
      put: () => Promise.reject(serviceError("AccessDenied", 403)),
    });

    const result = await new R2ObjectStore(c).put(KEY, BYTES);

    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
    if (result.ok) return;
    expect(result.error.message).toContain("AccessDenied");
  });
});

describe("getting an object", () => {
  it("hands back the bytes", async () => {
    const result = await new R2ObjectStore(client()).get(KEY);

    expect(result).toEqual({ ok: true, value: BYTES });
  });

  it("maps the SDK's own NoSuchKey to not_found", async () => {
    // The real class, not a hand-rolled shape: this assertion exists to prove the mapping
    // matches what the SDK actually throws, which a stub alone could never establish.
    const missing = new NoSuchKey({ message: "no such key", $metadata: { httpStatusCode: 404 } });
    const c = client({ get: () => Promise.reject(missing) });

    const result = await new R2ObjectStore(c).get(KEY);

    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("maps a bare 404 to not_found too", async () => {
    // A `HeadObject`-style 404 arrives as `NotFound`, which is a different class with the
    // same meaning. Matching on the status as well is what keeps them from diverging.
    const c = client({ get: () => Promise.reject(serviceError("NotFound", 404)) });

    const result = await new R2ObjectStore(c).get(KEY);

    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("keeps a store that cannot be reached distinct from a missing object", async () => {
    // Restoring a project treats these two completely differently: absent means fall back to
    // a fresh template, unreachable means refuse to open. Collapsing them loses work.
    const c = client({ get: () => Promise.reject(serviceError("TimeoutError", 500)) });

    const result = await new R2ObjectStore(c).get(KEY);

    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});

describe("deleting an object", () => {
  it("removes the object at the key", async () => {
    const c = client();

    const result = await new R2ObjectStore(c).delete(KEY);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(c.calls).toEqual([["delete", KEY]]);
  });

  it("succeeds when there was nothing there", async () => {
    // The port says so, and deleting a project depends on it: one snapshot already cleaned up
    // must not fail the cascade that removes the rest.
    const c = client({ delete: () => Promise.reject(serviceError("NoSuchKey", 404)) });

    const result = await new R2ObjectStore(c).delete(KEY);

    expect(result).toEqual({ ok: true, value: undefined });
  });

  it("still reports a store that refused the request", async () => {
    const c = client({ delete: () => Promise.reject(serviceError("AccessDenied", 403)) });

    const result = await new R2ObjectStore(c).delete(KEY);

    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});
