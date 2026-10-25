import { readFileSync } from "node:fs";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import { describe, expect, it } from "vitest";
import { DesktopRequestSchema } from "./desktop-protocol.ts";
import { E2BSandboxDesktop } from "./e2b-sandbox-desktop.ts";
import { InMemorySandboxManager } from "./testing/in-memory-sandbox-manager.ts";
import { isolatedDesktop } from "./testing/isolated-desktop.ts";

const jpeg = readFileSync(
  new URL("../../../docs/assets/computer-use/panel-review/fixture-desktop.jpg", import.meta.url),
);
function fixture(replies: unknown[]) {
  const sandbox: SandboxManager = new InMemorySandboxManager();
  const calls: { sandboxId: string; command: string; input: unknown }[] = [];
  sandbox.exec = async (sandboxId, command, onOutput) => {
    expect(onOutput).toBeUndefined();
    const encoded = command.match(/'([A-Za-z0-9+/=]+)'$/)?.[1];
    calls.push({
      sandboxId,
      command,
      input: encoded ? JSON.parse(Buffer.from(encoded, "base64").toString()) : null,
    });
    return {
      ok: true,
      value: { exitCode: 0, stdout: JSON.stringify(replies.shift()), stderr: "" },
    };
  };
  sandbox.getPreviewUrl = async (_id, port) => ({
    ok: true,
    value: `https://${port}-sandbox.e2b.test`,
  });
  const transport = new E2BSandboxDesktop({ sandbox });
  return { sandbox, calls, transport, desktop: isolatedDesktop(transport) };
}
const answer = (value: unknown) => ({ ok: true, value });

describe("E2B desktop through the existing exec port", () => {
  it("starts lazily with the project's exact loopback port", async () => {
    const f = fixture([answer({ width: 1024, height: 768 }), answer({ width: 1024, height: 768 })]);
    for (let i = 0; i < 2; i++)
      expect(
        await f.desktop.start({ sandboxId: "s", devServerUrl: "http://localhost:4321" }),
      ).toEqual(answer({ width: 1024, height: 768 }));
    expect(f.calls.map((c) => c.input)).toEqual([
      expect.objectContaining({ op: "start", port: 4321 }),
      expect.objectContaining({ op: "start", port: 4321 }),
    ]);
  });
  it.each([
    "https://example.com",
    "http://localhost:4321/path",
    "http://user:pass@localhost:4321",
    "http://other.localhost:4321",
  ])("refuses a non-project origin before effects: %s", async (devServerUrl) => {
    const f = fixture([]);
    expect(await f.desktop.start({ sandboxId: "s", devServerUrl })).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    expect(f.calls).toHaveLength(0);
  });
  it("transfers real JPEG bytes and validates their declared dimensions", async () => {
    const f = fixture([answer({ width: 1024, height: 768, data: jpeg.toString("base64") })]);
    expect(await f.desktop.screenshot("s")).toEqual(
      answer({ width: 1024, height: 768, bytes: Uint8Array.from(jpeg) }),
    );
    expect(f.calls[0]?.input).toMatchObject({ op: "screenshot" });
  });
  it.each([
    answer({ width: 1024, height: 768, data: "bm90LWEtanBlZw==" }),
    answer({ width: 5000, height: 768, data: jpeg.toString("base64") }),
    { ok: true, value: "bad response" },
  ])("rejects malformed frames", async (reply) => {
    const f = fixture([reply]);
    expect(await f.desktop.screenshot("s")).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });
  it("carries typed text as encoded data without shell interpolation or output callbacks", async () => {
    const f = fixture([answer({ kind: "none" })]);
    const text = "secret ' \" $(touch /tmp/should-not-exist) `id`\nend";
    expect(await f.desktop.act("s", { action: "type", text })).toEqual(answer({ kind: "none" }));
    expect(f.calls[0]?.command).not.toContain(text);
    expect(f.calls[0]?.input).toMatchObject({ op: "act", action: { action: "type", text } });
  });
  it("returns bounded DOM/cursor observations and private read-only stream credentials", async () => {
    const f = fixture([
      answer({ kind: "text", text: "DOM" }),
      answer({ kind: "cursor", coordinate: [10, 20] }),
      answer({ password: "aB1cD2eF" }),
    ]);
    expect(await f.desktop.act("s", { action: "read_dom" })).toEqual(
      answer({ kind: "text", text: "DOM" }),
    );
    expect(await f.desktop.act("s", { action: "cursor_position" })).toEqual(
      answer({ kind: "cursor", coordinate: [10, 20] }),
    );
    expect(await f.desktop.streamCredentials("s")).toEqual(
      answer({ url: "wss://6080-sandbox.e2b.test/websockify", password: "aB1cD2eF" }),
    );
  });
  it("returns typed failure without leaking remote output", async () => {
    const f = fixture([]);
    f.sandbox.exec = async () => ({
      ok: true,
      value: { exitCode: 1, stdout: "", stderr: "private password" },
    });
    expect(await f.desktop.act("s", { action: "left_click", coordinate: [1, 2] })).toMatchObject({
      ok: false,
      error: { code: "completion_unknown" },
    });
    expect(JSON.stringify(await f.desktop.screenshot("s"))).not.toContain("private password");
  });
  it("does not dispatch aborted work", async () => {
    const f = fixture([]);
    const signal = AbortSignal.abort();
    expect(
      await f.desktop.start({ sandboxId: "s", devServerUrl: "http://localhost:5173", signal }),
    ).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(await f.desktop.act("s", { action: "wait", duration: 3 }, signal)).toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(f.calls).toHaveLength(0);
  });
});

it("accepts the default HTTP port after URL normalization", async () => {
  const f = fixture([answer({ width: 1024, height: 768 })]);
  expect(
    await f.desktop.start({ sandboxId: "s", devServerUrl: "http://localhost:80" }),
  ).toMatchObject({ ok: true });
  expect(f.calls[0]?.input).toMatchObject({ op: "start", port: 80 });
});
it("preserves a typed driver failure even when its process exits nonzero", async () => {
  const f = fixture([]);
  f.sandbox.exec = async () => ({
    ok: true,
    value: {
      exitCode: 1,
      stdout: JSON.stringify({
        ok: false,
        error: { code: "not_started", message: "Desktop not started." },
      }),
      stderr: "",
    },
  });
  expect(await f.desktop.streamCredentials("s")).toMatchObject({
    ok: false,
    error: { code: "not_started" },
  });
});
it("cancels dispatched work by its own identity and discards a late success", async () => {
  const f = fixture([]);
  const controller = new AbortController();
  let finish: (() => void) | undefined;
  const calls: unknown[] = [];
  f.sandbox.exec = async (_id, command) => {
    const data = command.match(/'([A-Za-z0-9+/=]+)'$/)?.[1] ?? "";
    const request: unknown = JSON.parse(Buffer.from(data, "base64").toString());
    calls.push(request);
    if (calls.length === 1)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    else finish?.();
    return {
      ok: true,
      value: { exitCode: 0, stdout: JSON.stringify(answer({ kind: "none" })), stderr: "" },
    };
  };
  const result = f.desktop.act("s", { action: "wait", duration: 3 }, controller.signal);
  controller.abort();
  expect(await result).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(calls).toEqual([
    expect.objectContaining({ op: "observe", id: expect.any(String) }),
    expect.objectContaining({ op: "cancel", id: expect.any(String) }),
  ]);
  const pair = DesktopRequestSchema.array().parse(calls);
  expect(pair[0]?.id).toBe(pair[1]?.id);
});

it.each(["scope", "sandbox", "protocol", "ordinary-ack"])(
  "rejects %s as a drain certificate",
  async (mismatch) => {
    const scopeId = crypto.randomUUID();
    const value = { protocol: 2, kind: "scope_drained", scopeId, sandboxId: "s" };
    const reply =
      mismatch === "ordinary-ack"
        ? { kind: "none" }
        : {
            ...value,
            ...(mismatch === "scope" ? { scopeId: crypto.randomUUID() } : {}),
            ...(mismatch === "sandbox" ? { sandboxId: "other" } : {}),
            ...(mismatch === "protocol" ? { protocol: 1 } : {}),
          };
    const f = fixture([answer(reply)]);
    expect((await f.transport.closeAndDrain({ sandboxId: "s", scopeId })).ok).toBe(false);
    expect(f.calls[0]?.input).toMatchObject({ op: "close_scope", scopeId, sandboxId: "s" });
  },
);
// Exactly what the bundled driver prints with no argument, before and after scoped input.
const protocol1 = {
  protocol: 1,
  operations: ["start", "act", "screenshot", "credentials", "cancel"],
};
const protocol2 = { protocol: 2, operations: ["start", "act", "close_scope", "observe"] };
it.each([
  ["a scoped driver", protocol2, true],
  ["a driver from before scoped input", protocol1, false],
  ["a newer protocol without the drain", { protocol: 3, operations: ["act"] }, false],
  ["an unrecognised answer", { ok: true, value: { kind: "none" } }, false],
])("asks the driver's capabilities without input: %s", async (_name, reply, expected) => {
  const f = fixture([reply]);
  expect(await f.transport.supportsScopedInput({ sandboxId: "s" })).toBe(expected);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.sandboxId).toBe("s");
  expect(f.calls[0]?.input).toBeNull();
  expect(f.calls[0]?.command).toMatch(/node \/usr\/local\/lib\/nap-desktop\/driver\.mjs$/);
});
it("reports no scoped input when the machine cannot be asked", async () => {
  const f = fixture([]);
  f.sandbox.exec = async () => ({
    ok: false,
    error: { code: "unavailable", message: "gone" },
  });
  expect(await f.transport.supportsScopedInput({ sandboxId: "s" })).toBe(false);
});
