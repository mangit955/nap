import { expect, it } from "vitest";
import { DesktopImageSchema, RecordingVideoSchema } from "./desktop-protocol.ts";

it("validates a bounded large recording without a regular-expression stack overflow", () => {
  const data = Buffer.alloc(16_000_000, 1).toString("base64");
  expect(
    RecordingVideoSchema.safeParse({ data, durationMs: 1000, width: 1024, height: 768 }).success,
  ).toBe(true);
});
it("validates large screenshot data without a regular-expression stack overflow", () => {
  const data = Buffer.alloc(2_000_000, 1).toString("base64");
  expect(DesktopImageSchema.safeParse({ data, width: 1024, height: 768 }).success).toBe(true);
});
it.each(["A===", "AA=A", "YWJj\n", "a-_a", "***="])(
  "rejects malformed binary transport %j",
  (data) => {
    expect(DesktopImageSchema.safeParse({ data, width: 1024, height: 768 }).success).toBe(false);
    expect(
      RecordingVideoSchema.safeParse({
        data: data.repeat(6),
        durationMs: 1000,
        width: 1024,
        height: 768,
      }).success,
    ).toBe(false);
  },
);

it("allows transport for the largest schema-valid escaped text action", async () => {
  const { DESKTOP_REQUEST_MAX_BASE64_CHARS, DesktopRequestSchema } = await import(
    "./desktop-protocol.ts"
  );
  const request = DesktopRequestSchema.parse({
    id: crypto.randomUUID(),
    op: "act",
    action: { action: "type", text: "\u0001".repeat(10_000) },
  });
  expect(Buffer.from(JSON.stringify(request)).toString("base64").length).toBeLessThanOrEqual(
    DESKTOP_REQUEST_MAX_BASE64_CHARS,
  );
});
