import { expect, it } from "vitest";
import {
  DesktopImageSchema,
  DesktopRequestSchema,
  RecordingVideoSchema,
} from "./desktop-protocol.ts";

it("refuses physical input without a scope identity before dispatch", () => {
  expect(
    DesktopRequestSchema.safeParse({
      id: crypto.randomUUID(),
      op: "act",
      action: { action: "left_mouse_down" },
    }).success,
  ).toBe(false);
});

it("carries a validated scope UUID on physical input", () => {
  const request = {
    id: crypto.randomUUID(),
    scopeId: crypto.randomUUID(),
    sandboxId: "box",
    op: "act",
    action: { action: "left_mouse_down" },
  };
  expect(DesktopRequestSchema.safeParse(request)).toMatchObject({ success: true, data: request });
  expect(DesktopRequestSchema.safeParse({ ...request, scopeId: "invalid" }).success).toBe(false);
});

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
    scopeId: crypto.randomUUID(),
    sandboxId: "box",
    op: "act",
    action: { action: "type", text: "\u0001".repeat(10_000) },
  });
  expect(Buffer.from(JSON.stringify(request)).toString("base64").length).toBeLessThanOrEqual(
    DESKTOP_REQUEST_MAX_BASE64_CHARS,
  );
});
