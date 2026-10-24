import { describe, expect, it } from "vitest";
import {
  ComputerControlGrantSchema,
  ComputerControlStatusSchema,
  ComputerInputResultSchema,
  ComputerInputSchema,
  ComputerStreamSchema,
  HumanComputerActionSchema,
} from "./computer-access.ts";

const actions = [
  { action: "left_click", coordinate: [0, 0] },
  { action: "right_click", coordinate: [1023, 767] },
  { action: "middle_click", coordinate: [5, 5] },
  { action: "double_click", coordinate: [5, 5] },
  { action: "mouse_move", coordinate: [5, 5] },
  { action: "left_click_drag", start_coordinate: [0, 0], coordinate: [5, 5] },
  { action: "key", text: "ctrl+Return" },
  { action: "type", text: "hello" },
  { action: "scroll", scroll_direction: "down", scroll_amount: 2 },
];

describe("human computer wire boundaries", () => {
  it.each(actions)("accepts atomic $action and preserves JSON identity", (action) => {
    expect(HumanComputerActionSchema.parse(JSON.parse(JSON.stringify(action)))).toStrictEqual(
      action,
    );
  });
  it.each([
    { action: "wait", duration: 1 },
    { action: "hold_key", text: "Shift_L", duration: 1 },
    { action: "left_mouse_down" },
    { action: "left_mouse_up" },
    { action: "triple_click", coordinate: [1, 1] },
    { action: "zoom", region: [0, 0, 20, 20] },
    { action: "screenshot" },
    { action: "cursor_position" },
    { action: "read_dom" },
    { action: "console" },
    { action: "annotate", annotation: { type: "action", description: "input" } },
    { action: "javascript", code: "document.body.click()" },
  ])("rejects $action", (action) => {
    expect(HumanComputerActionSchema.safeParse(action).success).toBe(false);
  });
  it.each([
    { action: "left_click", coordinate: [1024, 0] },
    { action: "mouse_move", coordinate: [0, -1] },
    { action: "type", text: "x".repeat(2001) },
    { action: "key", text: "x".repeat(101) },
    { action: "key", text: "ctrl+" },
    { action: "key", text: "--window" },
    { action: "key", text: "Return space" },
    { action: "scroll", scroll_direction: "up", scroll_amount: 101 },
    { action: "key", text: "Return", duration: 2 },
    { action: "type", text: "safe", url: "https://evil.invalid" },
  ])("rejects unsafe or unbounded action %#", (action) => {
    expect(HumanComputerActionSchema.safeParse(action).success).toBe(false);
  });
  it("bounds and strictly validates the whole batch before dispatch", () => {
    const good = { grant: "signed-token", actions };
    expect(ComputerInputSchema.parse(good)).toStrictEqual(good);
    for (const bad of [
      { ...good, actions: [] },
      { ...good, actions: Array(17).fill(actions[0]) },
      { ...good, actions: [...actions, { action: "wait", duration: 1 }] },
      { ...good, sandboxId: "other" },
      { ...good, grant: "x".repeat(4097) },
    ])
      expect(ComputerInputSchema.safeParse(bad).success).toBe(false);
    const invalid = ComputerInputSchema.safeParse({
      ...good,
      actions: [{ action: "type", text: 1 }],
    });
    expect(invalid.error?.issues[0]?.path).toEqual(["actions", 0, "text"]);
  });
  it("validates private stream data without URL credentials or alternate protocols", () => {
    const good = {
      url: "wss://6080-box.e2b.app/websockify",
      password: "private",
      width: 1024,
      height: 768,
    };
    expect(ComputerStreamSchema.parse(good)).toStrictEqual(good);
    for (const url of [
      "javascript:alert(1)",
      "https://box.test",
      "wss://u:p@box.test",
      "wss://box.test/#secret",
      "wss://box.test/?password=secret",
    ])
      expect(ComputerStreamSchema.safeParse({ ...good, url }).success).toBe(false);
    expect(ComputerStreamSchema.safeParse({ ...good, width: 0 }).success).toBe(false);
    expect(ComputerStreamSchema.safeParse({ ...good, password: "" }).success).toBe(false);
  });
  it("validates status and short-lived grant responses with strict keys", () => {
    expect(ComputerControlStatusSchema.parse({ available: true })).toStrictEqual({
      available: true,
    });
    expect(ComputerInputResultSchema.parse({ applied: 16 })).toStrictEqual({ applied: 16 });
    expect(ComputerInputResultSchema.safeParse({ applied: 17 }).success).toBe(false);
    const grant = { grant: "signed-token", expiresAt: 1000 };
    expect(ComputerControlGrantSchema.parse(grant)).toStrictEqual(grant);
    expect(ComputerControlGrantSchema.safeParse({ ...grant, password: "private" }).success).toBe(
      false,
    );
  });
});
