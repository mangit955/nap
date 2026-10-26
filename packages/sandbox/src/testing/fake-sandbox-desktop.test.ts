import { DesktopActionSchema } from "@nap/shared/ports/sandbox-desktop";
import { describe, expect, it } from "vitest";
import { FakeSandboxDesktop } from "./fake-sandbox-desktop.ts";

const frame = { bytes: new Uint8Array([255, 216, 255, 217]), width: 1024, height: 768 };
const start = { sandboxId: "sandbox", devServerUrl: "http://localhost:5173" };

describe("FakeSandboxDesktop", () => {
  it("starts lazily and idempotently, without sharing state between sandboxes", async () => {
    const desktop = new FakeSandboxDesktop(frame);
    expect(await desktop.screenshot("sandbox")).toMatchObject({
      ok: false,
      error: { code: "not_started" },
    });
    expect(await desktop.start(start)).toEqual({ ok: true, value: { width: 1024, height: 768 } });
    await desktop.start(start);
    expect(desktop.starts).toEqual([start]);
    expect(await desktop.screenshot("other")).toMatchObject({
      ok: false,
      error: { code: "not_started" },
    });
  });

  it("records actions in order, protects inputs and returns scripted observations", async () => {
    const desktop = new FakeSandboxDesktop(frame);
    await desktop.start(start);
    const click = DesktopActionSchema.parse({ action: "left_click", coordinate: [512, 384] });
    await desktop.act("sandbox", click);
    if (click.action === "left_click") click.coordinate[0] = 1;
    desktop.observe({ kind: "text", text: "<main>hello</main>" });
    expect(await desktop.act("sandbox", { action: "read_dom" })).toEqual({
      ok: true,
      value: { kind: "text", text: "<main>hello</main>" },
    });
    expect(desktop.actions).toEqual([
      { sandboxId: "sandbox", action: { action: "left_click", coordinate: [512, 384] } },
      { sandboxId: "sandbox", action: { action: "read_dom" } },
    ]);
    await expect(desktop.act("sandbox", { action: "console" })).rejects.toThrow(/unscripted/i);
  });

  it("does not pretend DOM or console data exists and reports the cursor it actually moved", async () => {
    const desktop = new FakeSandboxDesktop(frame);
    await desktop.start(start);
    await desktop.act("sandbox", { action: "mouse_move", coordinate: [123, 234] });
    expect(await desktop.act("sandbox", { action: "cursor_position" })).toEqual({
      ok: true,
      value: { kind: "cursor", coordinate: [123, 234] },
    });
    await expect(desktop.act("sandbox", { action: "read_dom" })).rejects.toThrow(/unscripted/i);
  });

  it("copies screenshot buffers, including frames supplied after startup", async () => {
    const desktop = new FakeSandboxDesktop(frame);
    await desktop.start(start);
    const result = await desktop.screenshot("sandbox");
    expect(result).toEqual({ ok: true, value: frame });
    if (result.ok) result.value.bytes.fill(0);
    expect(await desktop.screenshot("sandbox")).toEqual({ ok: true, value: frame });
    const replacement = { ...frame, bytes: new Uint8Array([1, 2, 3]) };
    desktop.returning(replacement);
    replacement.bytes.fill(0);
    expect(await desktop.screenshot("sandbox")).toMatchObject({
      ok: true,
      value: { bytes: new Uint8Array([1, 2, 3]) },
    });
  });

  it("injects infrastructure failures and honors cancellation before effects", async () => {
    const desktop = new FakeSandboxDesktop(frame);
    desktop.failWith({ code: "unavailable", message: "desktop down" });
    expect(await desktop.start(start)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    desktop.failWith(undefined);
    const controller = new AbortController();
    controller.abort();
    expect(await desktop.start({ ...start, signal: controller.signal })).toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(desktop.starts).toEqual([]);
    await desktop.start(start);
    expect(
      await desktop.act("sandbox", { action: "type", text: "hello" }, controller.signal),
    ).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(desktop.actions).toEqual([]);
    expect(await desktop.streamCredentials("sandbox")).toEqual({
      ok: true,
      value: { url: "wss://desktop.invalid/sandbox", password: "fake-desktop-password" },
    });
  });
});

it.each([
  { action: "left_click", coordinate: [-1, 2] },
  { action: "left_click", coordinate: [1024, 2] },
  { action: "left_click", coordinate: [1, 768] },
  { action: "mouse_move", coordinate: [1.5, 2] },
  { action: "left_click_drag", start_coordinate: [1, 2], coordinate: [1, 900] },
  { action: "zoom", region: [30, 40, 20, 50] },
  { action: "zoom", region: [0, 0, 1025, 500] },
  { action: "wait", duration: 31 },
  { action: "scroll", scroll_direction: "down", scroll_amount: 101 },
  { action: "javascript", text: "document.body.remove()" },
  { action: "type", text: "secret", extra: "unknown" },
])("rejects invalid desktop action %j", (action) => {
  expect(DesktopActionSchema.safeParse(action).success).toBe(false);
});
