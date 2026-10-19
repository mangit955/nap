import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { verifyWebhook } from "./webhook.ts";

it("authenticates the exact signed bytes and rejects malformed, changed, or missing signatures", () => {
  const raw = '{"action":"deleted"}';
  const secret = "a-test-secret";
  const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  expect(verifyWebhook(raw, signature, secret)).toBe(true);
  expect(verifyWebhook(`${raw} `, signature, secret)).toBe(false);
  for (const invalid of [
    undefined,
    "sha1=123",
    "sha256=gg",
    "sha256=",
    `sha256=${"00".repeat(32)}`,
  ])
    expect(verifyWebhook(raw, invalid, secret)).toBe(false);
});
