import { describe, expect, it } from "vitest";
import { createHeartbeatWriter, HEARTBEAT_WRITE_INTERVAL_MS } from "./worker-heartbeat.ts";

/**
 * The file a worker's liveness probe reads, and the throttle in front of it.
 *
 * Tested against an injected clock and an injected write, because the assertions are about *how
 * often* the file is touched rather than about the filesystem — and a test that really wrote every
 * few milliseconds would be measuring a disk.
 */

function writer(overrides: { now?: () => number } = {}) {
  const writes: string[] = [];
  let clock = 0;
  const touch = createHeartbeatWriter("/tmp/alive", {
    now: overrides.now ?? (() => clock),
    write: (path) => writes.push(path),
  });
  return { touch, writes, advance: (ms: number) => (clock += ms) };
}

describe("createHeartbeatWriter", () => {
  it("touches the file on the first tick, so the pod becomes live at once", () => {
    const { touch, writes } = writer();
    touch();
    expect(writes).toEqual(["/tmp/alive"]);
  });

  it("throttles the ticks in between, because the loop comes round several times a second", () => {
    const { touch, writes, advance } = writer();
    touch();
    advance(HEARTBEAT_WRITE_INTERVAL_MS - 1);
    touch();
    touch();
    expect(writes).toHaveLength(1);
  });

  it("touches it again once the interval has passed", () => {
    const { touch, writes, advance } = writer();
    touch();
    advance(HEARTBEAT_WRITE_INTERVAL_MS);
    touch();
    expect(writes).toHaveLength(2);
  });
});
