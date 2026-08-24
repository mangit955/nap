import { describe, expect, it } from "vitest";
import { LEASE_GRACE_MS, LEASE_RENEWAL_INTERVAL_MS, LEASE_TTL_MS } from "./lease-windows.ts";

/**
 * Two assertions, and they are the only thing in the repo that would notice these three being
 * edited out of order. Each number looks arbitrary alone; their *relationships* are what make two
 * concurrent writers to one session unreachable.
 */
describe("the lease windows", () => {
  it("renews often enough to survive several missed renewals inside one lease", () => {
    expect(LEASE_TTL_MS).toBeGreaterThan(LEASE_RENEWAL_INTERVAL_MS * 2);
  });

  it("waits longer to reclaim a lease than a worker takes to notice losing it", () => {
    // The fencing margin: a worker that lost its lease has aborted by expiry + one renewal
    // interval, and the janitor only acts at expiry + the grace. Were this the other way round,
    // a session could be re-claimed while its previous worker was still appending to it.
    expect(LEASE_GRACE_MS).toBeGreaterThan(LEASE_RENEWAL_INTERVAL_MS);
  });
});
