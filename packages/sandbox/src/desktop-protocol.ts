import {
  DESKTOP_HEIGHT,
  DESKTOP_WIDTH,
  DesktopActionSchema,
} from "@nap/shared/ports/sandbox-desktop";
import { z } from "zod";

const identity = { id: z.uuid() };
export const DesktopRequestSchema = z.discriminatedUnion("op", [
  z.strictObject({ ...identity, op: z.literal("start"), port: z.int().min(1).max(65535) }),
  z.strictObject({ ...identity, op: z.literal("act"), action: DesktopActionSchema }),
  z.strictObject({ ...identity, op: z.literal("screenshot") }),
  z.strictObject({ ...identity, op: z.literal("credentials") }),
  z.strictObject({ ...identity, op: z.literal("cancel") }),
]);
export type DesktopRequest = z.infer<typeof DesktopRequestSchema>;
export const DesktopFailureSchema = z.strictObject({
  code: z.enum(["not_started", "unavailable", "cancelled", "timeout"]),
  message: z.string().max(300),
});
export const DesktopReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.unknown() }),
  z.strictObject({ ok: z.literal(false), error: DesktopFailureSchema }),
]);
export const DesktopSizeSchema = z.strictObject({
  width: z.literal(DESKTOP_WIDTH),
  height: z.literal(DESKTOP_HEIGHT),
});
export const DesktopImageSchema = z.strictObject({
  width: z.int().min(1).max(DESKTOP_WIDTH),
  height: z.int().min(1).max(DESKTOP_HEIGHT),
  data: z
    .string()
    .min(4)
    .max(3_000_000)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
export const DesktopObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("text"), text: z.string().max(120000) }),
  z.strictObject({
    kind: z.literal("cursor"),
    coordinate: z.tuple([
      z
        .int()
        .min(0)
        .max(DESKTOP_WIDTH - 1),
      z
        .int()
        .min(0)
        .max(DESKTOP_HEIGHT - 1),
    ]),
  }),
]);
export const DesktopPasswordSchema = z.strictObject({ password: z.string().min(8).max(32) });
export const DESKTOP_STATE = "/home/user/.nap-desktop";
export const DESKTOP_DRIVER = "/usr/local/lib/nap-desktop/driver.mjs";
export const DESKTOP_STREAM_PORT = 6080;
