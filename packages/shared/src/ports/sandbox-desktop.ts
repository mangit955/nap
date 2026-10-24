import { z } from "zod";
import type { Result } from "../result.ts";

export const DESKTOP_WIDTH = 1024;
export const DESKTOP_HEIGHT = 768;
const coordinate = z.tuple([
  z
    .int()
    .min(0)
    .max(DESKTOP_WIDTH - 1),
  z
    .int()
    .min(0)
    .max(DESKTOP_HEIGHT - 1),
]);
const region = z
  .tuple([
    z
      .int()
      .min(0)
      .max(DESKTOP_WIDTH - 1),
    z
      .int()
      .min(0)
      .max(DESKTOP_HEIGHT - 1),
    z.int().min(1).max(DESKTOP_WIDTH),
    z.int().min(1).max(DESKTOP_HEIGHT),
  ])
  .refine(
    ([left, top, right, bottom]) => right > left && bottom > top,
    "Region must have positive width and height.",
  );

/** Only observations and input. Lifecycle, credentials and recording are never model actions. */
export const DesktopActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("screenshot") }),
  z.strictObject({ action: z.literal("left_click"), coordinate }),
  z.strictObject({ action: z.literal("right_click"), coordinate }),
  z.strictObject({ action: z.literal("middle_click"), coordinate }),
  z.strictObject({ action: z.literal("double_click"), coordinate }),
  z.strictObject({ action: z.literal("triple_click"), coordinate }),
  z.strictObject({ action: z.literal("mouse_move"), coordinate }),
  z.strictObject({
    action: z.literal("left_click_drag"),
    start_coordinate: coordinate,
    coordinate,
  }),
  z.strictObject({ action: z.literal("left_mouse_down") }),
  z.strictObject({ action: z.literal("left_mouse_up") }),
  z.strictObject({ action: z.literal("cursor_position") }),
  z.strictObject({ action: z.literal("key"), text: z.string().min(1).max(100) }),
  z.strictObject({
    action: z.literal("hold_key"),
    text: z.string().min(1).max(100),
    duration: z.number().min(0.1).max(30),
  }),
  z.strictObject({ action: z.literal("type"), text: z.string().max(10000) }),
  z.strictObject({
    action: z.literal("scroll"),
    scroll_direction: z.enum(["up", "down", "left", "right"]),
    scroll_amount: z.int().min(1).max(100),
    coordinate: coordinate.optional(),
  }),
  z.strictObject({ action: z.literal("wait"), duration: z.number().min(0).max(30) }),
  z.strictObject({ action: z.literal("zoom"), region }),
  z.strictObject({ action: z.literal("read_dom") }),
  z.strictObject({ action: z.literal("console") }),
]);
export type DesktopAction = z.infer<typeof DesktopActionSchema>;
export type DesktopFrame = { bytes: Uint8Array; width: number; height: number };
export type DesktopObservation =
  | { kind: "none" }
  | { kind: "text"; text: string }
  | { kind: "cursor"; coordinate: [number, number] };
export type DesktopError = {
  code: "not_started" | "unavailable" | "cancelled" | "timeout";
  message: string;
};
export type DesktopStart = {
  sandboxId: string;
  devServerUrl: string;
  signal?: AbortSignal | undefined;
};

/** A project machine's desktop. Does not own the sandbox, turns, storage or authorization. */
export interface SandboxDesktop {
  start(options: DesktopStart): Promise<Result<{ width: number; height: number }, DesktopError>>;
  screenshot(sandboxId: string, signal?: AbortSignal): Promise<Result<DesktopFrame, DesktopError>>;
  act(
    sandboxId: string,
    action: DesktopAction,
    signal?: AbortSignal,
  ): Promise<Result<DesktopObservation, DesktopError>>;
  /** Private owner-only transport data. Never persist or publish these credentials. */
  streamCredentials(
    sandboxId: string,
  ): Promise<Result<{ url: string; password: string }, DesktopError>>;
}
