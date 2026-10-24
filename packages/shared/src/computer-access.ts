import { z } from "zod";
import { type DesktopAction, DesktopActionSchema } from "./ports/sandbox-desktop.ts";

const HUMAN_ACTIONS = [
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "mouse_move",
  "left_click_drag",
  "key",
  "type",
  "scroll",
] as const;

/** Whole physical gestures only. Held input must never survive the project guard. */
export const HumanComputerActionSchema = DesktopActionSchema.refine(
  (action): action is Extract<DesktopAction, { action: (typeof HUMAN_ACTIONS)[number] }> =>
    HUMAN_ACTIONS.some((allowed) => allowed === action.action),
  "Only atomic human input is allowed.",
)
  .refine((action) => action.action !== "type" || action.text.length <= 2000, "Text is too long.")
  .refine(
    (action) => action.action !== "key" || /^[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*$/.test(action.text),
    "Use an X11 keysym chord.",
  );
export type HumanComputerAction = z.infer<typeof HumanComputerActionSchema>;

export const ComputerInputSchema = z.strictObject({
  grant: z.string().min(1).max(4096),
  actions: z.array(HumanComputerActionSchema).min(1).max(16),
});
export type ComputerInput = z.infer<typeof ComputerInputSchema>;

export const ComputerStreamSchema = z.strictObject({
  url: z.url({ protocol: /^wss?$/ }).refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  }, "Stream URL must not carry credentials or parameters."),
  password: z.string().min(1).max(256),
  width: z.int().positive().max(16384),
  height: z.int().positive().max(16384),
});
export type ComputerStream = z.infer<typeof ComputerStreamSchema>;

export const ComputerControlStatusSchema = z.strictObject({ available: z.literal(true) });
export type ComputerControlStatus = z.infer<typeof ComputerControlStatusSchema>;
export const ComputerControlGrantSchema = z.strictObject({
  grant: ComputerInputSchema.shape.grant,
  /** Unix epoch milliseconds. A grant authorizes no work after this instant. */
  expiresAt: z.int().nonnegative(),
});
export type ComputerControlGrant = z.infer<typeof ComputerControlGrantSchema>;

export const ComputerInputResultSchema = z.strictObject({ applied: z.int().min(0).max(16) });
export type ComputerInputResult = z.infer<typeof ComputerInputResultSchema>;
