import type { DesktopInputTransport } from "@nap/shared/ports/desktop-input-transport";
import type {
  ComputerReservation,
  ProjectComputerAccess,
} from "@nap/shared/ports/project-computer-access";
import { expect, it, vi } from "vitest";
import { ProjectComputer } from "./project-computer.ts";

const projectId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
function fixture() {
  let row: ComputerReservation | undefined;
  const reserve = vi.fn<ProjectComputerAccess["reserve"]>(async (request) => {
    row = {
      ...request,
      state: "active",
      createdAt: new Date().toISOString(),
      nextRecoveryAt: new Date().toISOString(),
    };
    return { ok: true, value: row };
  });
  const clear = vi.fn<ProjectComputerAccess["clear"]>(async (request) => {
    if (row?.scopeId !== request.scopeId) return false;
    row = undefined;
    return true;
  });
  const store: ProjectComputerAccess = {
    reserve,
    clear,
    read: async () => ({ ok: true, value: { sandboxId: "box", revision: requestId } }),
    occupied: async () => row !== undefined,
    markRecovering: async () => {
      if (row) row.state = "recovering";
    },
    recoverable: async () => (row ? [row] : []),
    defer: async () => {},
  };
  const act = vi.fn<DesktopInputTransport["act"]>(async () => ({
    ok: true,
    value: { kind: "none" },
  }));
  const close = vi.fn<DesktopInputTransport["closeAndDrain"]>(async ({ scopeId, sandboxId }) => ({
    ok: true,
    value: { protocol: 2, kind: "scope_drained", scopeId, sandboxId },
  }));
  const transport: DesktopInputTransport = {
    act,
    closeAndDrain: close,
    observe: async () => ({ ok: true, value: { kind: "none" } }),
    start: async () => ({ ok: true, value: { width: 1024, height: 768 } }),
    screenshot: async () => ({
      ok: true,
      value: { width: 1024, height: 768, bytes: new Uint8Array() },
    }),
    streamCredentials: async () => ({
      ok: true,
      value: { url: "wss://example.invalid", password: "private" },
    }),
  };
  const computer = new ProjectComputer({ access: store, transport });
  const attempt = () =>
    computer.forTurn({ projectId, sandboxId: "box", lease: { requestId, owner: "worker" } });
  return { computer, attempt, store, reserve, clear, act, close, row: () => row };
}

it("reserves lazily once before dispatch, retains a held gesture across calls, and clears only after drain", async () => {
  const f = fixture();
  const scope = f.attempt();
  expect(f.reserve).not.toHaveBeenCalled();
  f.act.mockImplementation(async () => {
    expect(f.row()).toBeDefined();
    return { ok: true, value: { kind: "none" } };
  });
  await scope.desktop.act("box", { action: "left_mouse_down" });
  await scope.desktop.act("box", { action: "left_mouse_up" });
  expect(f.reserve).toHaveBeenCalledOnce();
  expect(f.row()).toBeDefined();
  expect((await scope.close()).ok).toBe(true);
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.clear).toHaveBeenCalledOnce();
  expect(f.row()).toBeUndefined();
  expect((await scope.close()).ok).toBe(true);
  expect(f.close).toHaveBeenCalledOnce();
  expect(scope.stopped()).toBe(false);
});
it("a no-input attempt sends no close or pointer release", async () => {
  const f = fixture();
  await f.attempt().close();
  expect(f.reserve).not.toHaveBeenCalled();
  expect(f.close).not.toHaveBeenCalled();
});
it("ambiguous reservation commit sends no input", async () => {
  const f = fixture();
  f.reserve.mockRejectedValue(new Error("commit acknowledgment lost"));
  const scope = f.attempt();
  expect((await scope.desktop.act("box", { action: "left_mouse_down" })).ok).toBe(false);
  expect(f.act).not.toHaveBeenCalled();
  expect(scope.stopped()).toBe(true);
});
it("unknown input is sticky after successful cleanup and cannot reserve again", async () => {
  const f = fixture();
  f.act.mockRejectedValue(new Error("output lost"));
  const scope = f.attempt();
  await scope.desktop.act("box", { action: "left_mouse_down" });
  await scope.close();
  expect(scope.stopped()).toBe(true);
  await scope.desktop.act("box", { action: "left_mouse_down" });
  expect(f.act).toHaveBeenCalledOnce();
  expect(f.reserve).toHaveBeenCalledOnce();
});
it("lost cleanup and wrong-scope proof retain exclusion for a new recovery instance", async () => {
  const f = fixture();
  const scope = f.attempt();
  await scope.desktop.act("box", { action: "left_mouse_down" });
  f.close.mockResolvedValue({
    ok: true,
    value: { protocol: 2, kind: "scope_drained", scopeId: requestId, sandboxId: "box" },
  });
  expect((await scope.close()).ok).toBe(false);
  expect(f.row()).toBeDefined();
  expect(f.clear).not.toHaveBeenCalled();
  f.close.mockImplementation(async ({ scopeId, sandboxId }) => ({
    ok: true,
    value: { protocol: 2, kind: "scope_drained", scopeId, sandboxId },
  }));
  await f.computer.recover(1);
  expect(f.row()).toBeUndefined();
  expect(scope.stopped()).toBe(true);
});
it("a failed database clear retains the row even after physical drain", async () => {
  const f = fixture();
  await f.attempt().desktop.act("box", { action: "left_mouse_down" });
  f.clear.mockRejectedValue(new Error("database disconnected"));
  expect((await f.computer.recover(1)).pending).toBe(1);
  expect(f.row()).toBeDefined();
});
