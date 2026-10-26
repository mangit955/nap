import { createHmac } from "node:crypto";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemoryProjectComputerAccess } from "@nap/db/testing/in-memory-project-computer-access";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { ProjectComputer } from "@nap/runtime/project-computer";
import { FakeSandboxDesktop } from "@nap/sandbox/testing/fake-sandbox-desktop";
import { ComputerControlGrantSchema } from "@nap/shared/computer-access";
import type { ProjectComputerAccess } from "@nap/shared/ports/project-computer-access";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp } from "../app.ts";
import { OWNER, PROJECT, SESSION, STRANGER } from "../auth/route-table.ts";
import { createLogger } from "../logger.ts";

const revision = "00000000-0000-4000-8000-000000000001";
const base = `/sessions/${SESSION}/computer`;

// HTTP policy uses a real in-memory reservation; cross-process admission belongs to DB tests.
class GuardStub extends InMemoryProjectComputerAccess {
  failure: "busy" | "not_found" | undefined;
  requests: { projectId: string; userId: string }[] = [];
  before: (() => void) | undefined;
  get computer() {
    const project = this.projects.get(PROJECT);
    if (!project) throw new Error("Missing fixture project.");
    return project;
  }
  get fenced(): boolean {
    return this.reservations.has(PROJECT);
  }
  override async read(request: {
    projectId: string;
    userId: string;
  }): ReturnType<ProjectComputerAccess["read"]> {
    this.requests.push({ projectId: request.projectId, userId: request.userId });
    if (this.failure) return { ok: false, error: { code: this.failure } };
    return super.read(request);
  }
  override async reserve(
    request: Parameters<ProjectComputerAccess["reserve"]>[0],
  ): ReturnType<ProjectComputerAccess["reserve"]> {
    this.before?.();
    return super.reserve(request);
  }
}

function fixture(
  user: string | null = OWNER,
  previewPort?: () => Promise<number>,
  secret = "test-auth-secret",
) {
  const sessions = new InMemorySessionStore([
    { sessionId: SESSION, projectId: PROJECT, userId: OWNER, sandboxId: "box" },
  ]);
  const desktop = new FakeSandboxDesktop({ bytes: new Uint8Array(), width: 1024, height: 768 });
  let time = 100_000;
  const access = new GuardStub(undefined, () => time);
  access.setProject({
    projectId: PROJECT,
    userId: OWNER,
    sessionIds: [SESSION],
    sandboxId: "box",
    revision,
  });
  const computer = new ProjectComputer({ access, transport: desktop.transport, now: () => time });
  const events = new InMemoryEventStore();
  const logs: string[] = [];
  const computerAccess = {
    sessions,
    desktop,
    access,
    computer,
    secret,
    now: () => time,
    ...(previewPort ? { previewPort } : {}),
  };
  const app = createApp({
    logger: createLogger(
      { level: "info" },
      {
        write: (line) => {
          logs.push(String(line));
        },
      },
    ),
    authenticate: async () => (user === null ? null : { userId: user, isAnonymous: false }),
    webOrigin: "https://nap.test",
    stream: {
      store: events,
      bus: new InMemoryEventBus(),
      upgradeWebSocket: async () => new Response(),
    },
    computerAccess,
  });
  const post = async (route: string, body: unknown = {}, headers?: Record<string, string>) =>
    app.request(`${base}/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const grant = async () => {
    const response = await post("control");
    expect(response.status).toBe(200);
    return ComputerControlGrantSchema.parse(await response.json());
  };
  return {
    app,
    sessions,
    desktop,
    access,
    events,
    logs,
    post,
    grant,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("owner desktop stream", () => {
  it("starts lazily on the existing sandbox with a canonical default URL and private credentials", async () => {
    const f = fixture();
    expect(f.desktop.starts).toEqual([]);
    const response = await f.app.request(`${base}/stream?url=https://evil.test&port=80`);
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({
      url: "wss://desktop.invalid/box",
      password: "fake-desktop-password",
      width: 1024,
      height: 768,
    });
    expect(f.desktop.starts).toEqual([{ sandboxId: "box", devServerUrl: "http://localhost:5173" }]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(JSON.stringify(f.logs)).not.toContain("fake-desktop-password");
    expect(JSON.stringify(f.logs)).not.toContain("desktop.invalid");
    expect(await f.events.readFrom(SESSION, 0)).toEqual([]);
  });
  it("gets the configured preview port from the owned session", async () => {
    const port = vi.fn(async () => 4321);
    const f = fixture(OWNER, port);
    expect((await f.app.request(`${base}/stream`)).status).toBe(200);
    expect(port).toHaveBeenCalledWith({
      sessionId: SESSION,
      projectId: PROJECT,
      userId: OWNER,
      sandboxId: "box",
    });
    expect(f.desktop.starts[0]?.devServerUrl).toBe("http://localhost:4321");
  });
  it.each([0, 65536, 1.5, Number.NaN])(
    "refuses invalid configured port %s before desktop effects",
    async (port) => {
      const f = fixture(OWNER, async () => port);
      expect((await f.app.request(`${base}/stream`)).status).toBe(503);
      expect(f.desktop.starts).toEqual([]);
    },
  );
  it.each([
    [null, 401],
    [STRANGER, 404],
  ] as const)("refuses %s before any effect", async (user, status) => {
    const port = vi.fn(async () => 5173);
    const f = fixture(user, port);
    const start = vi.spyOn(f.desktop, "start");
    const credentials = vi.spyOn(f.desktop, "streamCredentials");
    expect((await f.app.request(`${base}/stream`)).status).toBe(status);
    expect(port).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(credentials).not.toHaveBeenCalled();
  });
  it("gives missing and wrong-owner sessions the same 404", async () => {
    const missing = fixture();
    const other = fixture(STRANGER);
    const a = await missing.app.request(
      `${base.replace(SESSION, "00000000-0000-4000-8000-000000000099")}/stream`,
    );
    const b = await other.app.request(`${base}/stream`);
    expect(a.status).toBe(404);
    expect(await a.json()).toEqual(await b.json());
  });
  it("does not acquire a missing sandbox", async () => {
    const f = fixture();
    vi.spyOn(f.sessions, "get").mockResolvedValue({
      sessionId: SESSION,
      projectId: PROJECT,
      userId: OWNER,
      sandboxId: null,
    });
    expect((await f.app.request(`${base}/stream`)).status).toBe(503);
    expect(f.desktop.starts).toEqual([]);
  });
  it("sanitizes returned and thrown desktop failures", async () => {
    const f = fixture();
    f.desktop.failWith({ code: "unavailable", message: "private-password" });
    let response = await f.app.request(`${base}/stream`);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-password");
    vi.spyOn(f.desktop, "start").mockRejectedValue(new Error("private-password"));
    response = await f.app.request(`${base}/stream`);
    expect(response.status).toBe(503);
    expect(JSON.stringify(f.logs)).not.toContain("private-password");
  });
  it("cancels an abandoned stream start before it can contend for credentials", async () => {
    const f = fixture();
    const controller = new AbortController();
    const start = vi.spyOn(f.desktop, "start").mockImplementation(async () => {
      controller.abort();
      return { ok: true, value: { width: 1024, height: 768 } };
    });
    const credentials = vi.spyOn(f.desktop, "streamCredentials");
    const response = await f.app.request(
      new Request(`http://localhost${base}/stream`, { signal: controller.signal }),
    );
    expect(response.status).toBe(503);
    expect(start.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(credentials).not.toHaveBeenCalled();
  });
  it("validates credentials before returning them", async () => {
    const f = fixture();
    vi.spyOn(f.desktop, "streamCredentials").mockResolvedValue({
      ok: true,
      value: { url: "javascript:private", password: "private" },
    });
    const response = await f.app.request(`${base}/stream`);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
  });
});

describe("idle control grants and guarded input", () => {
  it("checks the owned project for status and issues a 60 second grant without starting the desktop", async () => {
    const f = fixture();
    const response = await f.app.request(`${base}/control`);
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ available: true });
    const grant = await f.grant();
    expect(grant.expiresAt).toBe(160_000);
    expect(f.access.requests).toEqual([
      { projectId: PROJECT, userId: OWNER },
      { projectId: PROJECT, userId: OWNER },
    ]);
    expect(f.desktop.starts).toEqual([]);
    expect(JSON.stringify(f.logs)).not.toContain(grant.grant);
  });
  it.each(["control", "input"])(
    "denies %s to unauthenticated and other owners before the project guard",
    async (route) => {
      for (const [user, status] of [
        [null, 401],
        [STRANGER, 404],
      ] as const) {
        const f = fixture(user);
        expect(
          (await f.post(route, { grant: "invalid", actions: [{ action: "key", text: "Return" }] }))
            .status,
        ).toBe(status);
        expect(f.access.requests).toEqual([]);
      }
    },
  );
  it("returns busy for all three guarded endpoints without desktop effects", async () => {
    const f = fixture();
    const { grant } = await f.grant();
    f.access.failure = "busy";
    for (const response of [
      await f.app.request(`${base}/control`),
      await f.post("control"),
      await f.post("input", { grant, actions: [{ action: "key", text: "Return" }] }),
    ]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "busy" });
    }
    expect(f.desktop.actions).toEqual([]);
  });
  it("uses locked project sandbox state rather than the earlier session lookup", async () => {
    const f = fixture();
    f.access.computer.sandboxId = null;
    expect((await f.app.request(`${base}/control`)).status).toBe(503);
    expect((await f.post("control")).status).toBe(503);
    f.access.failure = "not_found";
    expect((await f.post("control")).status).toBe(404);
  });
  it("applies ordered physical input under a committed reservation without events or typed values in logs", async () => {
    const f = fixture();
    await f.app.request(`${base}/stream`);
    const { grant } = await f.grant();
    const act = vi.spyOn(f.desktop, "act");
    act.mockImplementation(async () => {
      expect(f.access.fenced).toBe(true);
      return { ok: true, value: { kind: "none" } };
    });
    const actions = [
      { action: "type", text: "private-input" },
      { action: "key", text: "ctrl+Return" },
    ];
    const response = await f.post("input", { grant, actions });
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ applied: 2 });
    expect(act.mock.calls.map((call) => call.slice(0, 2))).toEqual(
      actions.map((action) => ["box", action]),
    );
    expect(f.access.fenced).toBe(false);
    expect(await f.events.readFrom(SESSION, 0)).toEqual([]);
    for (const secret of ["private-input", grant])
      expect(JSON.stringify(f.logs)).not.toContain(secret);
  });
  it.each([
    "expiry",
    "revision",
    "sandbox",
    "session-sandbox",
    "tamper",
    "session",
    "user",
    "project",
    "secret",
  ])("rejects %s changes before physical input", async (change) => {
    const f = fixture();
    let { grant } = await f.grant();
    if (change === "expiry") f.advance(60_000);
    if (change === "revision") f.access.computer.revision = "00000000-0000-4000-8000-000000000002";
    if (change === "sandbox") f.access.computer.sandboxId = "replacement";
    if (change === "session-sandbox") await f.sessions.setSandboxId(SESSION, "replacement");
    if (change === "tamper") grant = grant.replace(/.$/, (last) => (last === "A" ? "B" : "A"));
    if (["session", "user", "project"].includes(change)) {
      const record = await f.sessions.get(SESSION);
      if (!record) throw new Error("missing fixture");
      vi.spyOn(f.sessions, "get").mockResolvedValue({
        ...record,
        ...(change === "session"
          ? { sessionId: "00000000-0000-4000-8000-000000000099" }
          : change === "user"
            ? { userId: STRANGER }
            : { projectId: "00000000-0000-4000-8000-000000000099" }),
      });
    }
    if (change === "secret")
      grant = (await fixture(OWNER, undefined, "different-secret").grant()).grant;
    const response = await f.post("input", {
      grant,
      actions: [{ action: "type", text: "secret" }],
    });
    expect(response.status).toBe(change === "user" ? 404 : 409);
    expect(f.desktop.actions).toEqual([]);
  });
  it("checks revision and expiry after entering the reservation transaction", async () => {
    for (const change of ["revision", "expiry"] as const) {
      const f = fixture();
      const { grant } = await f.grant();
      f.access.before = () => {
        if (change === "expiry") f.advance(60_000);
        else f.access.computer.revision = "00000000-0000-4000-8000-000000000002";
      };
      expect(
        (await f.post("input", { grant, actions: [{ action: "key", text: "Return" }] })).status,
      ).toBe(409);
      expect(f.desktop.actions).toEqual([]);
    }
  });
  it("validates every action before any physical input", async () => {
    const f = fixture();
    const { grant } = await f.grant();
    const response = await f.post("input", {
      grant,
      actions: [{ action: "key", text: "Return" }, { action: "left_mouse_down" }],
    });
    expect(response.status).toBe(400);
    expect(f.desktop.actions).toEqual([]);
    expect(f.access.requests).toHaveLength(1);
  });
  it("stops after a partial batch failure and never replays input", async () => {
    const f = fixture();
    const { grant } = await f.grant();
    const act = vi
      .spyOn(f.desktop, "act")
      .mockResolvedValueOnce({ ok: true, value: { kind: "none" } })
      .mockResolvedValueOnce({ ok: false, error: { code: "timeout", message: "private-input" } });
    const response = await f.post("input", {
      grant,
      actions: Array(3).fill({ action: "key", text: "Return" }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ applied: 1 });
    expect(act).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.logs)).not.toContain("private-input");
  });
  it("retains the durable fence when aborted input has no drain proof", async () => {
    const f = fixture();
    const { grant } = await f.grant();
    vi.spyOn(f.desktop.transport, "closeAndDrain").mockResolvedValue({
      ok: false,
      error: { code: "timeout", message: "No drain proof." },
    });
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let release = () => {};
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const act = vi.spyOn(f.desktop, "act").mockImplementation(async (_sandbox, _action, signal) => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      expect(signal?.aborted).toBe(true);
      expect(f.access.fenced).toBe(true);
      return { ok: true, value: { kind: "none" } };
    });
    try {
      let settled = false;
      const pending = f
        .post("input", { grant, actions: Array(2).fill({ action: "key", text: "Return" }) })
        .then((response) => {
          settled = true;
          return response;
        });
      await started;
      expect(timeout).toHaveBeenCalledWith(5000);
      deadline.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.access.fenced).toBe(true);
      expect((await pending).status).toBe(503);
      expect(settled).toBe(true);
      release();
      expect((await pending).status).toBe(503);
      expect(act).toHaveBeenCalledTimes(1);
      expect(f.access.fenced).toBe(true);
    } finally {
      release();
      timeout.mockRestore();
    }
  });
  it("rejects cross-site writes and non-JSON simple requests", async () => {
    const f = fixture();
    for (const route of ["control", "input"]) {
      expect((await f.post(route, {}, { origin: "https://evil.test" })).status).toBe(403);
      expect((await f.post(route, {}, { "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect((await f.post(route, {}, { "content-type": "text/plain" })).status).toBe(415);
    }
    expect(f.access.requests).toEqual([]);
    expect(
      (await f.post("control", {}, { origin: "https://nap.test", "sec-fetch-site": "cross-site" }))
        .status,
    ).toBe(200);
  });
  it("rejects client routing data, unknown body keys and malformed JSON before guard effects", async () => {
    const f = fixture();
    expect((await f.post("control", { url: "http://evil.test" })).status).toBe(400);
    expect(
      (
        await f.post("input", {
          grant: "g",
          actions: [{ action: "key", text: "Return" }],
          sandboxId: "other",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.app.request(`${base}/control`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(f.access.requests).toEqual([]);
  });
});

it("keeps all access routes absent without optional composition", async () => {
  const app = createApp({
    logger: createLogger({ level: "silent" }, { write: () => {} }),
    authenticate: async () => ({ userId: OWNER, isAnonymous: false }),
    stream: {
      store: new InMemoryEventStore(),
      bus: new InMemoryEventBus(),
      upgradeWebSocket: async () => new Response(),
    },
  });
  for (const [method, route] of [
    ["GET", "stream"],
    ["GET", "control"],
    ["POST", "control"],
    ["POST", "input"],
  ] as const)
    expect((await app.request(`${base}/${route}`, { method })).status).toBe(404);
});

it("rejects oversized encoded JSON before granting control", async () => {
  const f = fixture();
  const response = await f.app.request(`${base}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: `{}${" ".repeat(256 * 1024)}`,
  });
  expect(response.status).toBe(400);
  expect(f.access.requests).toEqual([]);
});

it("stops dispatch when the client disconnects or the grant expires between actions", async () => {
  for (const cause of ["disconnect", "expiry"] as const) {
    const f = fixture();
    const { grant } = await f.grant();
    const abort = new AbortController();
    const act = vi.spyOn(f.desktop, "act").mockImplementation(async () => {
      if (cause === "disconnect") abort.abort();
      else f.advance(60_000);
      return { ok: true, value: { kind: "none" } };
    });
    const response = await f.app.request(`${base}/input`, {
      method: "POST",
      signal: abort.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant, actions: Array(2).fill({ action: "key", text: "Return" }) }),
    });
    expect(response.status).toBe(503);
    expect(act).toHaveBeenCalledTimes(1);
  }
});

it("sanitizes ambiguous physical failures and stops the batch without replay", async () => {
  const f = fixture();
  const { grant } = await f.grant();
  const act = vi.spyOn(f.desktop, "act").mockRejectedValue(new Error("private-typed-text"));
  const response = await f.post("input", {
    grant,
    actions: Array(2).fill({ action: "type", text: "private-typed-text" }),
  });
  expect(response.status).toBe(503);
  expect(act).toHaveBeenCalledTimes(1);
  expect(f.access.fenced).toBe(false);
  expect(await response.text()).not.toContain("private-typed-text");
  expect(JSON.stringify(f.logs)).not.toContain("private-typed-text");
});

it("requires the namespaced MAC and rejects unknown signed claim keys", async () => {
  const f = fixture();
  const { grant } = await f.grant();
  const [, payload] = grant.split(".");
  if (!payload) throw new Error("missing token payload");
  const claims = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
  const key = createHmac("sha256", "test-auth-secret")
    .update("nap:computer-control:key:v1")
    .digest();
  const extra = Buffer.from(JSON.stringify({ ...claims, admin: true })).toString("base64url");
  const extraSignature = createHmac("sha256", key)
    .update(`nap-computer-v1.${extra}`)
    .digest("base64url");
  const authSignature = createHmac("sha256", "test-auth-secret")
    .update(`nap-computer-v1.${payload}`)
    .digest("base64url");
  for (const token of [
    `nap-computer-v1.${extra}.${extraSignature}`,
    `nap-computer-v1.${payload}.${authSignature}`,
    "nap-computer-v1.a.a",
    "",
    `${grant}.extra`,
  ]) {
    const response = await f.post("input", {
      grant: token,
      actions: [{ action: "key", text: "Return" }],
    });
    expect([400, 409]).toContain(response.status);
  }
  const otherUserPayload = Buffer.from(JSON.stringify({ ...claims, userId: STRANGER })).toString(
    "base64url",
  );
  const otherUserMac = createHmac("sha256", key)
    .update(`nap-computer-v1.${otherUserPayload}`)
    .digest("base64url");
  expect(
    (
      await f.post("input", {
        grant: `nap-computer-v1.${otherUserPayload}.${otherUserMac}`,
        actions: [{ action: "key", text: "Return" }],
      })
    ).status,
  ).toBe(409);
  expect(f.desktop.actions).toEqual([]);
});
