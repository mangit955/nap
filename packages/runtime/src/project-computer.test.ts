import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import type { DesktopInputTransport } from "@nap/shared/ports/desktop-input-transport";
import {
  ABANDON_AFTER_MS,
  type ComputerReservation,
  type ProjectComputerAccess,
} from "@nap/shared/ports/project-computer-access";
import { expect, it, vi } from "vitest";
import {
  ABANDONED_COMPUTER_NOTICE,
  type AbandonAnnouncement,
  ProjectComputer,
} from "./project-computer.ts";

const projectId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
function fixture(options: { now?: () => number; announce?: AbandonAnnouncement } = {}) {
  let row: ComputerReservation | undefined;
  let busy = false;
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
    held: async ({ userId }) =>
      userId === "owner"
        ? { ok: true, value: { reservation: row ? structuredClone(row) : null, busy } }
        : { ok: false, error: { code: "not_found" } },
    abandon: async () => {
      row = undefined;
      return { ok: true, value: { released: true } };
    },
  };
  const abandon = vi.spyOn(store, "abandon");
  const act = vi.fn<DesktopInputTransport["act"]>(async () => ({
    ok: true,
    value: { kind: "none" },
  }));
  const close = vi.fn<DesktopInputTransport["closeAndDrain"]>(async ({ scopeId, sandboxId }) => ({
    ok: true,
    value: { protocol: 2, kind: "scope_drained", scopeId, sandboxId },
  }));
  const supports = vi.fn<DesktopInputTransport["supportsScopedInput"]>(async () => "yes");
  const transport: DesktopInputTransport = {
    act,
    closeAndDrain: close,
    supportsScopedInput: supports,
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
  const computer = new ProjectComputer({
    access: store,
    transport,
    ...(options.now ? { now: options.now } : {}),
    ...(options.announce ? { announce: options.announce } : {}),
  });
  const attempt = () =>
    computer.forTurn({ projectId, sandboxId: "box", lease: { requestId, owner: "worker" } });
  return {
    computer,
    attempt,
    store,
    reserve,
    clear,
    abandon,
    act,
    close,
    supports,
    row: () => row,
    /** What the reaper's own successful drain leaves behind. */
    drop: () => {
      row = undefined;
    },
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}
const binding = {
  projectId,
  sessionId: "00000000-0000-4000-8000-000000000003",
  userId: "owner",
  sandboxId: "box",
  revision: requestId,
  expiresAt: Number.MAX_SAFE_INTEGER,
};

// A machine created before scoped input rejects the scoped act and cannot drain, so a
// reservation committed against it could never clear. Its project must stay usable.
it.each([
  ["reports an older protocol", async () => "no" as const, /Close and reopen the project/],
  ["could not say", async () => "unknown" as const, /unavailable right now/],
  [
    "cannot be asked",
    async (): Promise<"yes"> => {
      throw new Error("exec lost");
    },
    /unavailable right now/,
  ],
])(
  "a driver that %s gets no reservation, input or close from the model",
  async (_name, answer, message) => {
    const f = fixture();
    f.supports.mockImplementation(answer);
    const scope = f.attempt();
    const result = await scope.desktop.act("box", { action: "left_click", coordinate: [1, 1] });
    // Only a definite older answer may tell the model to reopen; a hiccup on a current machine is
    // not a reason to throw its workspace away.
    expect(result).toMatchObject({
      ok: false,
      error: { code: "unavailable", message: expect.stringMatching(message) },
    });
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.act).not.toHaveBeenCalled();
    expect(scope.stopped()).toBe(false);
    expect((await scope.close()).ok).toBe(true);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.row()).toBeUndefined();
  },
);
it.each([
  // Only a definite older driver is something its owner can fix, by closing and reopening.
  ["no", "outdated"],
  ["unknown", "unavailable"],
] as const)(
  "a driver that answers %s gets no reservation, input or close from its owner",
  async (answer, code) => {
    const f = fixture();
    f.supports.mockResolvedValue(answer);
    const result = await f.computer.ownerInput({
      binding,
      actions: [{ action: "left_click", coordinate: [1, 1] }],
    });
    expect(result).toEqual({ ok: false, error: { code, applied: 0 } });
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.act).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  },
);
it("asks the exact machine before its first reservation, and remembers a yes", async () => {
  const f = fixture();
  f.reserve.mockImplementation(async (request) => {
    expect(f.supports).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: "box" }));
    return {
      ok: true,
      value: { ...request, state: "active", createdAt: "", nextRecoveryAt: "" },
    };
  });
  for (let i = 0; i < 2; i++) {
    const scope = f.attempt();
    expect((await scope.desktop.act("box", { action: "left_mouse_down" })).ok).toBe(true);
    await scope.close();
  }
  expect(f.reserve).toHaveBeenCalledTimes(2);
  expect(f.supports).toHaveBeenCalledOnce();
});

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

it("never reserves for an attempt that closed while it was asking the driver", async () => {
  const f = fixture();
  let answer = (_value: "yes") => {};
  f.supports.mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const scope = f.attempt();
  const acting = scope.desktop.act("box", { action: "left_mouse_down" });
  await Promise.resolve();
  expect((await scope.close()).ok).toBe(true);
  answer("yes");
  expect((await acting).ok).toBe(false);
  expect(f.reserve).not.toHaveBeenCalled();
  expect(f.act).not.toHaveBeenCalled();
});

const owned = { projectId, userId: "owner" };
/** A server clock past every abandon window, for tests about what happens once it has passed. */
const later = () => Date.now() + ABANDON_AFTER_MS;
async function strand(f: ReturnType<typeof fixture>) {
  f.act.mockRejectedValueOnce(new Error("output lost"));
  const scope = f.attempt();
  await scope.desktop.act("box", { action: "left_mouse_down" });
  f.close.mockResolvedValue({ ok: false, error: { code: "unavailable", message: "gone" } });
  await scope.close();
  expect(f.row()).toMatchObject({ state: "recovering" });
}
it("reports a stranded project as stuck, and when its owner may abandon the machine", async () => {
  const f = fixture();
  expect(await f.computer.recovery(owned)).toEqual({ ok: true, value: { stuck: false } });
  await strand(f);
  const createdAt = Date.parse(f.row()?.createdAt ?? "");
  expect(await f.computer.recovery(owned)).toEqual({
    ok: true,
    value: { stuck: true, abandonableAt: createdAt + ABANDON_AFTER_MS },
  });
  expect(await f.computer.recovery({ ...owned, userId: "stranger" })).toEqual({
    ok: false,
    error: { code: "not_found" },
  });
});
it("a turn still holding its lease is working, not stuck", async () => {
  const f = fixture();
  await strand(f);
  f.setBusy(true);
  expect(await f.computer.recovery(owned)).toEqual({ ok: true, value: { stuck: false } });
});
it("tries one more drain before abandoning, and a proof keeps the machine", async () => {
  const f = fixture({ now: later });
  await strand(f);
  f.close.mockImplementation(async ({ scopeId, sandboxId }) => ({
    ok: true,
    value: { protocol: 2, kind: "scope_drained", scopeId, sandboxId },
  }));
  expect(await f.computer.abandon(owned)).toEqual({ ok: true, value: { outcome: "recovered" } });
  expect(f.abandon).not.toHaveBeenCalled();
  expect(f.row()).toBeUndefined();
});
it("abandons exactly the held scope once the drain fails again", async () => {
  const f = fixture({ now: later });
  await strand(f);
  const held = f.row();
  expect(await f.computer.abandon(owned)).toEqual({ ok: true, value: { outcome: "abandoned" } });
  expect(f.abandon).toHaveBeenCalledWith({
    projectId,
    sandboxId: "box",
    scopeId: held?.scopeId,
    userId: "owner",
  });
});
it("never drains or abandons a scope a live turn still holds", async () => {
  const f = fixture({ now: later });
  await strand(f);
  f.setBusy(true);
  f.close.mockClear();
  expect(await f.computer.abandon(owned)).toEqual({ ok: false, error: { code: "busy" } });
  expect(f.close).not.toHaveBeenCalled();
  expect(f.abandon).not.toHaveBeenCalled();
});
it("has nothing to abandon when nothing is held, and the database's clock has the last word", async () => {
  const f = fixture({ now: later });
  expect(await f.computer.abandon(owned)).toEqual({ ok: true, value: { outcome: "clear" } });
  await strand(f);
  f.abandon.mockResolvedValueOnce({ ok: false, error: { code: "too_early" } });
  expect(await f.computer.abandon(owned)).toEqual({
    ok: false,
    error: {
      code: "too_early",
      abandonableAt: Date.parse(f.row()?.createdAt ?? "") + ABANDON_AFTER_MS,
    },
  });
});
it("refuses an early abandon before draining anything", async () => {
  // A young owner reservation may be a batch still running in another tab; draining it would
  // revoke that batch's scope mid-action.
  const f = fixture();
  await f.attempt().desktop.act("box", { action: "left_mouse_down" });
  const held = f.row();
  expect(await f.computer.abandon(owned)).toEqual({
    ok: false,
    error: {
      code: "too_early",
      abandonableAt: Date.parse(held?.createdAt ?? "") + ABANDON_AFTER_MS,
    },
  });
  expect(f.close).not.toHaveBeenCalled();
  expect(f.abandon).not.toHaveBeenCalled();
  expect(f.row()).toEqual(held);
});
it("answers clear, not a conflict, when the reaper drained the scope while abandon was trying", async () => {
  const f = fixture({ now: later });
  await strand(f);
  f.close.mockImplementation(async ({ scopeId, sandboxId }) => {
    f.drop();
    return { ok: true, value: { protocol: 2, kind: "scope_drained", scopeId, sandboxId } };
  });
  f.abandon.mockResolvedValueOnce({ ok: false, error: { code: "stale_grant" } });
  expect(await f.computer.abandon(owned)).toEqual({ ok: true, value: { outcome: "clear" } });
});
it("still reports a conflict when a different reservation has replaced the one it saw", async () => {
  const f = fixture({ now: later });
  await strand(f);
  f.abandon.mockResolvedValueOnce({ ok: false, error: { code: "stale_grant" } });
  expect(await f.computer.abandon(owned)).toEqual({
    ok: false,
    error: { code: "stale_grant" },
  });
});
it("counts a reservation with no lease as stuck only once it has stood for a minute", async () => {
  let clock = Date.now();
  const f = fixture({ now: () => clock });
  // Reserved and still active: no lost reply, so only its age can say nobody is working on it.
  await f.attempt().desktop.act("box", { action: "left_mouse_down" });
  const createdAt = Date.parse(f.row()?.createdAt ?? "");
  expect(f.row()?.state).toBe("active");
  clock = createdAt + 30_000;
  expect(await f.computer.recovery(owned)).toEqual({ ok: true, value: { stuck: false } });
  clock = createdAt + 61_000;
  expect(await f.computer.recovery(owned)).toEqual({
    ok: true,
    value: { stuck: true, abandonableAt: createdAt + ABANDON_AFTER_MS },
  });
});

function announcing(sessionIds = ["session-a", "session-b"]) {
  const events = new InMemoryEventStore();
  const sessions = vi.fn(async () => sessionIds);
  return {
    events,
    sessions,
    announce: {
      events,
      bus: new InMemoryEventBus(),
      sessionIds: sessions,
      now: () => "2026-10-25T00:00:00.000Z",
    },
  };
}
it("writes the abandon into every session of the project, so history matches the workspace", async () => {
  const a = announcing();
  const f = fixture({ now: later, announce: a.announce });
  await strand(f);
  expect(await f.computer.abandon(owned)).toEqual({ ok: true, value: { outcome: "abandoned" } });
  expect(a.sessions).toHaveBeenCalledWith(owned);
  for (const sessionId of ["session-a", "session-b"]) {
    const written = await a.events.readFrom(sessionId, 0);
    expect(written.map((event) => event.type)).toEqual(["system.notice", "preview.stopped"]);
    expect(written[0]?.payload).toEqual({ level: "warning", text: ABANDONED_COMPUTER_NOTICE });
  }
});
it("writes nothing when the project had already moved to another machine", async () => {
  const a = announcing();
  const f = fixture({ now: later, announce: a.announce });
  await strand(f);
  f.abandon.mockResolvedValueOnce({ ok: true, value: { released: false } });
  expect(await f.computer.abandon(owned)).toEqual({ ok: true, value: { outcome: "abandoned" } });
  expect(await a.events.readFrom("session-a", 0)).toEqual([]);
});
it("still abandons when the notice cannot be written", async () => {
  const a = announcing();
  a.sessions.mockRejectedValue(new Error("database disconnected"));
  const f = fixture({ now: later, announce: a.announce });
  await strand(f);
  expect(await f.computer.abandon(owned)).toEqual({ ok: true, value: { outcome: "abandoned" } });
});
