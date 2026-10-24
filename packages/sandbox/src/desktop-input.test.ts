import type { DesktopAction } from "@nap/shared/ports/sandbox-desktop";
import { describe, expect, it } from "vitest";
import { type DesktopActionHost, performDesktopAction } from "./desktop-input.ts";

function fixture() {
  const calls: { args: readonly string[]; input?: string; signal?: AbortSignal }[] = [];
  const waits: number[] = [];
  const crops: number[][] = [];
  const host: DesktopActionHost = {
    xdotool: async (args, options) => {
      calls.push({ args, ...options });
      return "X=12\nY=24\nSCREEN=0\nWINDOW=0\n";
    },
    sleep: async (ms) => {
      waits.push(ms);
    },
    observe: async (kind) => (kind === "dom" ? "page DOM" : "browser console"),
    zoom: async (region) => {
      crops.push(region);
    },
  };
  return { host, calls, waits, crops };
}
describe("physical desktop action driver", () => {
  it.each([
    ["left_click", "1", "1"],
    ["right_click", "3", "1"],
    ["middle_click", "2", "1"],
    ["double_click", "1", "2"],
    ["triple_click", "1", "3"],
  ] satisfies [DesktopAction["action"], string, string][])(
    "maps %s to real mouse input",
    async (action, button, count) => {
      const f = fixture();
      if (
        action !== "left_click" &&
        action !== "right_click" &&
        action !== "middle_click" &&
        action !== "double_click" &&
        action !== "triple_click"
      )
        throw Error("bad fixture");
      expect(await performDesktopAction({ action, coordinate: [10, 20] }, f.host)).toEqual({
        kind: "none",
      });
      expect(f.calls[0]?.args).toEqual([
        "mousemove",
        "--sync",
        "10",
        "20",
        "click",
        "--repeat",
        count,
        "--delay",
        "100",
        button,
      ]);
    },
  );
  it("types through stdin and maps named key chords", async () => {
    const f = fixture();
    const text = "' $(id) `echo unsafe`\nUnicode ✓";
    await performDesktopAction({ action: "type", text }, f.host);
    expect(f.calls[0]).toMatchObject({
      args: ["type", "--clearmodifiers", "--delay", "1", "--file", "-"],
      input: text,
    });
    await performDesktopAction({ action: "key", text: "CTRL+ENTER" }, f.host);
    expect(f.calls[1]?.args).toEqual(["key", "--clearmodifiers", "ctrl+Return"]);
  });
  it("releases a held key with a fresh cleanup operation after cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.host.sleep = async () => {
      controller.abort();
      throw Error("aborted");
    };
    await expect(
      performDesktopAction(
        { action: "hold_key", text: "SHIFT", duration: 1 },
        f.host,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(f.calls.map((c) => c.args)).toEqual([
      ["keydown", "Shift_L"],
      ["keyup", "Shift_L"],
    ]);
    expect(f.calls[1]?.signal).toBeUndefined();
  });
  it("releases the drag button when movement fails", async () => {
    const f = fixture();
    f.host.xdotool = async (args, options) => {
      f.calls.push({ args, ...options });
      if (args[0] === "mousemove" && args.includes("mousedown")) throw Error("movement failed");
      return "";
    };
    await expect(
      performDesktopAction(
        { action: "left_click_drag", start_coordinate: [1, 2], coordinate: [3, 4] },
        f.host,
      ),
    ).rejects.toThrow();
    expect(f.calls.at(-1)?.args).toEqual(["mouseup", "1"]);
  });
  it("covers explicit button state, pointer movement, scrolling and waits", async () => {
    const f = fixture();
    await performDesktopAction({ action: "left_mouse_down" }, f.host);
    await performDesktopAction({ action: "left_mouse_up" }, f.host);
    await performDesktopAction({ action: "mouse_move", coordinate: [2, 3] }, f.host);
    await performDesktopAction(
      { action: "scroll", scroll_direction: "down", scroll_amount: 4, coordinate: [20, 30] },
      f.host,
    );
    await performDesktopAction({ action: "wait", duration: 0.5 }, f.host);
    expect(f.calls.map((c) => c.args)).toEqual([
      ["mousedown", "1"],
      ["mouseup", "1"],
      ["mousemove", "--sync", "2", "3"],
      ["mousemove", "--sync", "20", "30", "click", "--repeat", "4", "--delay", "15", "5"],
    ]);
    expect(f.waits).toEqual([500]);
  });
  it("returns actual cursor and bounded read-only observations and consumes zoom separately", async () => {
    const f = fixture();
    expect(await performDesktopAction({ action: "cursor_position" }, f.host)).toEqual({
      kind: "cursor",
      coordinate: [12, 24],
    });
    expect(await performDesktopAction({ action: "read_dom" }, f.host)).toEqual({
      kind: "text",
      text: "page DOM",
    });
    expect(await performDesktopAction({ action: "console" }, f.host)).toEqual({
      kind: "text",
      text: "browser console",
    });
    await performDesktopAction({ action: "zoom", region: [1, 2, 30, 40] }, f.host);
    expect(f.crops).toEqual([[1, 2, 30, 40]]);
    expect(await performDesktopAction({ action: "screenshot" }, f.host)).toEqual({ kind: "none" });
  });
  it("dispatches nothing after cancellation", async () => {
    const f = fixture();
    await expect(
      performDesktopAction(
        { action: "left_click", coordinate: [0, 0] },
        f.host,
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
});
