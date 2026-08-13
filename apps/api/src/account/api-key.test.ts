import { describe, expect, it } from "vitest";
import { hintFor, parseApiKey } from "./api-key.ts";

const OPENROUTER = "sk-or-v1-0123456789abcdef0123";
const ANTHROPIC = "sk-ant-api03-0123456789abcdef";

describe("parseApiKey", () => {
  it("reads the platform off the prefix", () => {
    expect(parseApiKey(OPENROUTER)).toEqual({
      ok: true,
      value: { platform: "openrouter", apiKey: OPENROUTER },
    });
    expect(parseApiKey(ANTHROPIC)).toEqual({
      ok: true,
      value: { platform: "anthropic", apiKey: ANTHROPIC },
    });
  });

  it("trims the whitespace a copy-paste brings with it", () => {
    // A key copied out of a terminal or a dashboard arrives with a newline about half the time.
    expect(parseApiKey(`  ${OPENROUTER}\n`)).toMatchObject({ value: { apiKey: OPENROUTER } });
  });

  it("refuses a paste with whitespace inside it", () => {
    // The usual form of this is a whole shell line — `export KEY=…` — which would otherwise be
    // sealed, stored, and fail on every turn with nothing connecting the two.
    expect(parseApiKey(`export KEY=${OPENROUTER}`)).toMatchObject({ ok: false });
  });

  it("refuses an empty paste with something to do about it", () => {
    expect(parseApiKey("   ")).toEqual({ ok: false, message: "Paste a key first." });
  });

  it("refuses a key from neither vendor, naming both prefixes", () => {
    const refusal = parseApiKey("sk-proj-0123456789abcdefghij");

    expect(refusal.ok).toBe(false);
    // The message has to say what a good key looks like: somebody pasting an OpenAI key here
    // has no other way to find out that this is not the place for it.
    expect(refusal.ok === false && refusal.message).toContain("sk-or-");
    expect(refusal.ok === false && refusal.message).toContain("sk-ant-");
  });

  it("refuses a prefix typed by hand with no key after it", () => {
    expect(parseApiKey("sk-or-")).toMatchObject({ ok: false });
  });
});

describe("hintFor", () => {
  it("keeps the vendor prefix and the last four characters", () => {
    expect(hintFor(OPENROUTER)).toBe("sk-or-…0123");
    expect(hintFor(ANTHROPIC)).toBe("sk-ant-…cdef");
  });

  it("never contains the middle of the key", () => {
    expect(hintFor(OPENROUTER)).not.toContain("v1-0123456789");
  });
});
