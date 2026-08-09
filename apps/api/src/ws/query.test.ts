import { describe, expect, it } from "vitest";
import { parseStreamQuery } from "./query.ts";

/** `?sessionId=…&seq=N` — the only thing a client controls before the upgrade. */
function query(search: string) {
  return parseStreamQuery(new URL(`http://localhost:3001/ws${search}`));
}

describe("parseStreamQuery", () => {
  it("reads a session id and a sequence number", () => {
    const result = query("?sessionId=0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f&seq=12");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      sessionId: "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f",
      afterSeq: 12,
    });
  });

  it("defaults a missing seq to 0, which means the whole transcript", () => {
    const result = query("?sessionId=0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.afterSeq).toBe(0);
  });

  it.each([
    ["no session id", "?seq=1"],
    ["a session id that is not a uuid", "?sessionId=session-1"],
    ["an empty session id", "?sessionId="],
  ])("rejects %s", (_name, search) => {
    const result = query(search);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/sessionId/);
  });

  it.each([
    ["negative", "seq=-1"],
    ["fractional", "seq=1.5"],
    ["not a number", "seq=abc"],
    ["empty", "seq="],
  ])("rejects a %s seq", (_name, seq) => {
    // A bad seq must not fall back to 0: silently replaying an entire transcript because a
    // client sent `seq=NaN` is how a reconnect loop turns into a duplicate-message bug.
    const result = query(`?sessionId=0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f&${seq}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/seq/);
  });

  it("names every problem at once", () => {
    const result = query("?seq=-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/sessionId/);
    expect(result.error.message).toMatch(/seq/);
  });
});
