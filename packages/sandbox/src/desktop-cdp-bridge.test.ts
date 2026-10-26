import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BRIDGE_CLIENT_LIMIT,
  BROWSER_FRAME_LIMIT_BYTES,
  CdpRouter,
  CLIENT_FRAME_LIMIT_BYTES,
  NulFrames,
  probeCdpBridge,
  runCdpBridge,
} from "./desktop-cdp-bridge.ts";

// A stand-in browser speaking Chrome's pipe contract: it reads NUL-terminated JSON from
// descriptor 3 and writes replies and events to descriptor 4. It logs what it received
// so a test can prove what reached the browser, and what it did with signals.
const FAKE_BROWSER = `import fs from 'node:fs';
import net from 'node:net';
const [log, mode = ''] = process.argv.slice(2);
const note = (value) => fs.appendFileSync(log, JSON.stringify(value) + '\\n');
note({ launched: process.pid });
const input = new net.Socket({ fd: 3, readable: true, writable: false });
const output = new net.Socket({ fd: 4, readable: false, writable: true });
const send = (value) => output.write(JSON.stringify(value) + '\\0');
let sessions = 0;
let buffer = '';
input.on('data', (chunk) => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\\0')) >= 0) {
    const frame = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    let message;
    try { message = JSON.parse(frame); } catch { note({ partial: frame.length }); continue; }
    note({ received: message });
    const { id, method, params = {}, sessionId } = message;
    const reply = (result) => send({ id, result, ...(sessionId ? { sessionId } : {}) });
    if (method === 'Browser.getVersion') reply({ product: 'Fake/1', protocolVersion: '1.3' });
    else if (method === 'Target.attachToTarget') reply({ sessionId: 'S' + ++sessions });
    else if (method === 'Fixture.emit') {
      send({ method: 'Fixture.event', params: { text: params.text }, ...(params.sessionId ? { sessionId: params.sessionId } : {}) });
      reply({});
    } else if (method === 'Fixture.browserEvent') {
      send({ method: params.method, params: params.params });
      reply({});
    } else if (method === 'Fixture.big') reply({ data: 'x'.repeat(params.size) });
    else if (method === 'Fixture.exit') process.exit(params.code);
    else reply(params);
  }
});
process.on('SIGTERM', () => {
  note({ signal: 'SIGTERM' });
  if (mode !== 'stubborn') setTimeout(() => process.exit(0), 150);
});
if (mode === 'silent') input.pause();
`;

let root = "";
let fake = "";
let driver = "";
const cleanups: (() => void)[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ncdp-"));
  fake = join(root, "browser.mjs");
  writeFileSync(fake, FAKE_BROWSER);
  driver = join(root, "driver.mjs");
  // The same bundle the template ships, so the dispatch is tested as Node will run it.
  const bundle = spawnSync(
    "bun",
    [
      "build",
      fileURLToPath(new URL("../scripts/desktop-driver.ts", import.meta.url)),
      "--target=node",
      "--format=esm",
      `--outfile=${driver}`,
    ],
    { encoding: "utf8" },
  );
  expect(bundle.status, bundle.stderr).toBe(0);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

let sequence = 0;
function paths() {
  const id = ++sequence;
  return { socket: join(root, `s${id}.sock`), log: join(root, `l${id}.jsonl`) };
}
function logged(log: string): Record<string, unknown>[] {
  return existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}
function received(log: string): { method?: string; params?: Record<string, unknown> }[] {
  return logged(log).flatMap((entry) =>
    entry.received ? [entry.received as { method?: string; params?: Record<string, unknown> }] : [],
  );
}
function bridge(mode = "", stopGraceMs = 2000) {
  const { socket, log } = paths();
  const stop = new AbortController();
  const exited = runCdpBridge({
    socketPath: socket,
    command: process.execPath,
    args: [fake, log, mode],
    stopGraceMs,
    stop: stop.signal,
  });
  cleanups.push(() => stop.abort());
  return { socket, log, stop, exited };
}
async function listening(socket: string) {
  await expect.poll(() => existsSync(socket) && lstatSync(socket).isSocket()).toBe(true);
}

/** A raw protocol client, so the tests do not depend on the code under test to speak. */
class Client {
  readonly frames: Record<string, unknown>[] = [];
  closed = false;
  #buffer = "";
  readonly connection: Socket;
  constructor(path: string) {
    this.connection = createConnection(path);
    this.connection.on("data", (chunk) => {
      this.#buffer += chunk.toString();
      let end = this.#buffer.indexOf("\0");
      while (end >= 0) {
        this.frames.push(JSON.parse(this.#buffer.slice(0, end)));
        this.#buffer = this.#buffer.slice(end + 1);
        end = this.#buffer.indexOf("\0");
      }
    });
    this.connection.on("error", () => {});
    this.connection.on("close", () => {
      this.closed = true;
    });
    cleanups.push(() => this.connection.destroy());
  }
  async open() {
    await once(this.connection, "connect");
    return this;
  }
  send(message: unknown) {
    this.connection.write(`${JSON.stringify(message)}\0`);
  }
  async reply(id: number) {
    await expect.poll(() => this.frames.some((frame) => frame.id === id)).toBe(true);
    return this.frames.find((frame) => frame.id === id);
  }
}

describe("NUL framing", () => {
  it("joins frames across chunks and splits several in one chunk", () => {
    const frames = new NulFrames(100);
    expect(frames.push(Buffer.from('{"a":'))).toEqual({ frames: [], overflow: false });
    expect(frames.push(Buffer.from('1}\0{"b":2}\0{"c"'))).toEqual({
      frames: ['{"a":1}', '{"b":2}'],
      overflow: false,
    });
    expect(frames.push(Buffer.from(":3}\0"))).toEqual({ frames: ['{"c":3}'], overflow: false });
  });

  it("discards an oversized frame through its terminator and resumes with the next", () => {
    const frames = new NulFrames(8);
    expect(frames.push(Buffer.from("x".repeat(6)))).toEqual({ frames: [], overflow: false });
    expect(frames.push(Buffer.from("x".repeat(6)))).toEqual({ frames: [], overflow: true });
    expect(frames.push(Buffer.from("xxxx\0ok\0"))).toEqual({ frames: ["ok"], overflow: false });
    expect(frames.push(Buffer.from(`${"y".repeat(9)}\0z\0`))).toEqual({
      frames: ["z"],
      overflow: true,
    });
  });
});

describe("routing", () => {
  function router() {
    const browser: Record<string, unknown>[] = [];
    const route = new CdpRouter((frame) => browser.push(JSON.parse(frame)));
    const client = () => {
      const frames: Record<string, unknown>[] = [];
      const handle = { send: (frame: string) => frames.push(JSON.parse(frame)) };
      route.connect(handle);
      return { handle, frames };
    };
    return { route, browser, client };
  }

  function fillRequests(route: CdpRouter, client: Parameters<CdpRouter["connect"]>[0]) {
    let accepted = 0;
    for (let id = 1; id <= 128; id++) {
      if (!route.fromClient(client, JSON.stringify({ id, method: "Target.getTargets" }))) break;
      accepted++;
    }
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(128);
    return accepted;
  }

  it("bounds unanswered requests without dropping another client's pending reply", () => {
    const { route, browser, client } = router();
    const healthy = client();
    const busy = client();
    expect(
      route.fromClient(healthy.handle, JSON.stringify({ id: 1, method: "Browser.getVersion" })),
    ).toBe(true);
    const healthyId = browser[0]?.id;
    const accepted = fillRequests(route, busy.handle);
    expect(browser).toHaveLength(accepted + 1);
    const refused = client();
    expect(
      route.fromClient(refused.handle, JSON.stringify({ id: 1, method: "Browser.getVersion" })),
    ).toBe(false);
    expect(browser).toHaveLength(accepted + 1);
    route.disconnect(refused.handle);
    route.disconnect(busy.handle);
    route.fromBrowser(JSON.stringify({ id: healthyId, result: { product: "healthy" } }));
    expect(healthy.frames).toEqual([{ id: 1, result: { product: "healthy" } }]);
    expect(busy.frames).toEqual([]);
    expect(
      route.fromClient(healthy.handle, JSON.stringify({ id: 2, method: "Browser.getVersion" })),
    ).toBe(true);
    route.fromBrowser(
      JSON.stringify({ id: browser.at(-1)?.id, result: { product: "still here" } }),
    );
    expect(healthy.frames.at(-1)).toEqual({ id: 2, result: { product: "still here" } });
  });

  it("reclaims unanswered ordinary requests across disconnect cycles", () => {
    const { route, browser, client } = router();
    let capacity: number | undefined;
    for (let cycle = 0; cycle < 3; cycle++) {
      const current = client();
      const start = browser.length;
      const accepted = fillRequests(route, current.handle);
      capacity ??= accepted;
      expect(accepted).toBe(capacity);
      expect(browser).toHaveLength(start + accepted);
      route.disconnect(current.handle);
      expect(current.frames).toEqual([]);
    }
    const healthy = client();
    expect(
      route.fromClient(healthy.handle, JSON.stringify({ id: 1, method: "Browser.getVersion" })),
    ).toBe(true);
    route.fromBrowser(JSON.stringify({ id: browser[0]?.id, result: { product: "expired" } }));
    expect(healthy.frames).toEqual([]);
    route.fromBrowser(JSON.stringify({ id: browser.at(-1)?.id, result: { product: "healthy" } }));
    expect(healthy.frames).toEqual([{ id: 1, result: { product: "healthy" } }]);
  });

  it("restores request capacity after a discarded oversized DOM reply and disconnect", () => {
    const { route, browser, client } = router();
    const baseline = client();
    const capacity = fillRequests(route, baseline.handle);
    route.disconnect(baseline.handle);
    const observer = client();
    expect(
      route.fromClient(observer.handle, JSON.stringify({ id: 1, method: "Target.attachToTarget" })),
    ).toBe(true);
    route.fromBrowser(JSON.stringify({ id: browser.at(-1)?.id, result: { sessionId: "DOM" } }));
    expect(
      route.fromClient(
        observer.handle,
        JSON.stringify({
          id: 2,
          method: "DOM.getOuterHTML",
          params: { nodeId: 1 },
          sessionId: "DOM",
        }),
      ),
    ).toBe(true);
    const domId = browser.at(-1)?.id;
    const framing = new NulFrames(BROWSER_FRAME_LIMIT_BYTES);
    const read = framing.push(
      Buffer.from(
        `${JSON.stringify({
          id: domId,
          sessionId: "DOM",
          result: { outerHTML: "x".repeat(BROWSER_FRAME_LIMIT_BYTES) },
        })}\0`,
      ),
    );
    expect(read.overflow).toBe(true);
    expect(read.frames).toEqual([]);
    for (const frame of read.frames) route.fromBrowser(frame);
    expect(observer.frames).toEqual([{ id: 1, result: { sessionId: "DOM" } }]);
    route.disconnect(observer.handle);
    expect(browser.at(-1)).toMatchObject({
      method: "Target.detachFromTarget",
      params: { sessionId: "DOM" },
    });
    route.fromBrowser(JSON.stringify({ id: browser.at(-1)?.id, result: {} }));
    const healthy = client();
    const start = browser.length;
    expect(fillRequests(route, healthy.handle)).toBe(capacity);
    expect(browser).toHaveLength(start + capacity);
    route.fromBrowser(
      JSON.stringify({ id: domId, sessionId: "DOM", result: { outerHTML: "late" } }),
    );
    expect(healthy.frames).toEqual([]);
    route.fromBrowser(JSON.stringify({ id: browser[start]?.id, result: { targetInfos: [] } }));
    expect(healthy.frames).toEqual([{ id: 1, result: { targetInfos: [] } }]);
    expect(observer.frames).toHaveLength(1);
  });

  it("bounds orphan attaches and keeps detaching late successes while cleanup is unanswered", () => {
    const { route, browser, client } = router();
    const healthy = client();
    expect(
      route.fromClient(healthy.handle, JSON.stringify({ id: 1, method: "Target.attachToTarget" })),
    ).toBe(true);
    route.fromBrowser(JSON.stringify({ id: browser[0]?.id, result: { sessionId: "healthy" } }));
    const orphans: Record<string, unknown>[] = [];
    for (let attempt = 0; attempt < 128; attempt++) {
      const current = client();
      const start = browser.length;
      const accepted = route.fromClient(
        current.handle,
        JSON.stringify({ id: 1, method: "Target.attachToTarget" }),
      );
      route.disconnect(current.handle);
      expect(current.frames).toEqual([]);
      if (!accepted) {
        expect(browser).toHaveLength(start);
        break;
      }
      expect(browser).toHaveLength(start + 1);
      const request = browser.at(-1);
      expect(request).toBeDefined();
      if (request === undefined) throw new Error("Accepted attach was not sent to the browser.");
      orphans.push(request);
    }
    expect(orphans.length).toBeGreaterThan(0);
    expect(orphans.length).toBeLessThan(128);
    const replacement = client();
    const detachStart = browser.length;
    for (const [index, request] of orphans.entries()) {
      route.fromBrowser(
        JSON.stringify({ id: request.id, result: { sessionId: `orphan-${index}` } }),
      );
      expect(browser.at(-1)).toMatchObject({
        method: "Target.detachFromTarget",
        params: { sessionId: `orphan-${index}` },
      });
    }
    expect(browser).toHaveLength(detachStart + orphans.length);
    expect(
      route.fromClient(
        replacement.handle,
        JSON.stringify({ id: 1, method: "Target.attachToTarget" }),
      ),
    ).toBe(false);
    expect(browser).toHaveLength(detachStart + orphans.length);
    route.disconnect(replacement.handle);
    route.fromBrowser(
      JSON.stringify({ method: "Log.entryAdded", sessionId: "orphan-0", params: {} }),
    );
    expect(replacement.frames).toEqual([]);
    expect(healthy.frames).toHaveLength(1);
    route.fromBrowser(JSON.stringify({ id: browser[detachStart]?.id, result: {} }));
    const next = client();
    expect(
      route.fromClient(next.handle, JSON.stringify({ id: 1, method: "Target.attachToTarget" })),
    ).toBe(true);
    route.fromBrowser(
      JSON.stringify({ id: browser.at(-1)?.id, result: { sessionId: "replacement" } }),
    );
    expect(next.frames).toEqual([{ id: 1, result: { sessionId: "replacement" } }]);
    route.fromBrowser(
      JSON.stringify({ method: "Log.entryAdded", sessionId: "healthy", params: {} }),
    );
    expect(healthy.frames.at(-1)).toEqual({
      method: "Log.entryAdded",
      sessionId: "healthy",
      params: {},
    });
    expect(next.frames).toHaveLength(1);
  });

  it("bounds unanswered disconnect detaches and recovers only when cleanup replies", () => {
    const { route, browser, client } = router();
    const healthy = client();
    expect(
      route.fromClient(healthy.handle, JSON.stringify({ id: 1, method: "Target.attachToTarget" })),
    ).toBe(true);
    route.fromBrowser(JSON.stringify({ id: browser[0]?.id, result: { sessionId: "healthy" } }));
    const detaches: Record<string, unknown>[] = [];
    for (let attempt = 0; attempt < 128; attempt++) {
      const current = client();
      const start = browser.length;
      const accepted = route.fromClient(
        current.handle,
        JSON.stringify({ id: 1, method: "Target.attachToTarget" }),
      );
      if (!accepted) {
        route.disconnect(current.handle);
        expect(browser).toHaveLength(start);
        break;
      }
      route.fromBrowser(
        JSON.stringify({ id: browser.at(-1)?.id, result: { sessionId: `S${attempt}` } }),
      );
      expect(current.frames).toEqual([{ id: 1, result: { sessionId: `S${attempt}` } }]);
      route.disconnect(current.handle);
      expect(browser).toHaveLength(start + 2);
      const detach = browser.at(-1);
      expect(detach).toMatchObject({
        method: "Target.detachFromTarget",
        params: { sessionId: `S${attempt}` },
      });
      if (detach === undefined) throw new Error("Disconnected session was not detached.");
      detaches.push(detach);
      route.disconnect(current.handle);
      expect(browser).toHaveLength(start + 2);
    }
    expect(detaches.length).toBeGreaterThan(0);
    expect(detaches.length).toBeLessThan(128);
    route.fromBrowser(
      JSON.stringify({ method: "Log.entryAdded", sessionId: "healthy", params: {} }),
    );
    expect(healthy.frames).toEqual([
      { id: 1, result: { sessionId: "healthy" } },
      { method: "Log.entryAdded", sessionId: "healthy", params: {} },
    ]);
    route.fromBrowser(JSON.stringify({ id: detaches[0]?.id, result: {} }));
    const replacement = client();
    expect(
      route.fromClient(
        replacement.handle,
        JSON.stringify({ id: 1, method: "Target.attachToTarget" }),
      ),
    ).toBe(true);
    route.fromBrowser(
      JSON.stringify({ id: browser.at(-1)?.id, result: { sessionId: "replacement" } }),
    );
    expect(replacement.frames).toEqual([{ id: 1, result: { sessionId: "replacement" } }]);
  });

  it("gives each client its own ids and only its own replies", () => {
    const { route, browser, client } = router();
    const a = client();
    const b = client();
    expect(
      route.fromClient(a.handle, JSON.stringify({ id: 1, method: "Browser.getVersion" })),
    ).toBe(true);
    expect(
      route.fromClient(b.handle, JSON.stringify({ id: 1, method: "Browser.getVersion" })),
    ).toBe(true);
    const [first, second] = browser;
    expect(first?.id).not.toBe(second?.id);
    route.fromBrowser(JSON.stringify({ id: second?.id, result: { product: "for b" } }));
    route.fromBrowser(JSON.stringify({ id: first?.id, result: { product: "for a" } }));
    route.fromBrowser(JSON.stringify({ id: 999, result: { product: "nobody's" } }));
    expect(a.frames).toEqual([{ id: 1, result: { product: "for a" } }]);
    expect(b.frames).toEqual([{ id: 1, result: { product: "for b" } }]);
  });

  it("delivers a session's events only to the client that attached it", () => {
    const { route, browser, client } = router();
    const a = client();
    const b = client();
    route.fromClient(a.handle, JSON.stringify({ id: 7, method: "Target.attachToTarget" }));
    route.fromBrowser(JSON.stringify({ id: browser[0]?.id, result: { sessionId: "S1" } }));
    route.fromBrowser(JSON.stringify({ method: "Log.entryAdded", sessionId: "S1", params: {} }));
    route.fromBrowser(JSON.stringify({ method: "Log.entryAdded", sessionId: "S9", params: {} }));
    route.fromBrowser(JSON.stringify({ method: "Target.targetCreated", params: {} }));
    expect(a.frames.map((frame) => frame.method ?? frame.id)).toEqual([7, "Log.entryAdded"]);
    expect(b.frames).toEqual([]);
    // Another client may neither speak on nor detach a session it does not own.
    expect(
      route.fromClient(b.handle, JSON.stringify({ id: 1, method: "DOM.enable", sessionId: "S1" })),
    ).toBe(false);
    expect(
      route.fromClient(
        b.handle,
        JSON.stringify({
          id: 2,
          method: "Target.detachFromTarget",
          params: { sessionId: "S1" },
        }),
      ),
    ).toBe(false);
    expect(browser).toHaveLength(1);
    route.fromBrowser(
      JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: "S1" } }),
    );
    expect(a.frames.at(-1)?.method).toBe("Target.detachedFromTarget");
    expect(
      route.fromClient(a.handle, JSON.stringify({ id: 8, method: "DOM.enable", sessionId: "S1" })),
    ).toBe(false);
  });

  it("detaches what a disconnected client left attached, including a late attach", () => {
    const { route, browser, client } = router();
    const a = client();
    route.fromClient(a.handle, JSON.stringify({ id: 1, method: "Target.attachToTarget" }));
    route.fromClient(a.handle, JSON.stringify({ id: 2, method: "Target.attachToTarget" }));
    route.fromBrowser(JSON.stringify({ id: browser[0]?.id, result: { sessionId: "S1" } }));
    route.disconnect(a.handle);
    route.fromBrowser(JSON.stringify({ id: browser[1]?.id, result: { sessionId: "S2" } }));
    expect(browser.slice(2)).toEqual([
      expect.objectContaining({ method: "Target.detachFromTarget", params: { sessionId: "S1" } }),
      expect.objectContaining({ method: "Target.detachFromTarget", params: { sessionId: "S2" } }),
    ]);
    const delivered = a.frames.length;
    route.fromBrowser(JSON.stringify({ id: browser[2]?.id, result: {} }));
    route.fromBrowser(JSON.stringify({ method: "Log.entryAdded", sessionId: "S2", params: {} }));
    expect(a.frames).toHaveLength(delivered);
    expect(route.fromClient(a.handle, JSON.stringify({ id: 3, method: "Browser.close" }))).toBe(
      false,
    );
  });

  it.each([
    "not json",
    "[]",
    JSON.stringify({ method: "Browser.getVersion" }),
    JSON.stringify({ id: -1, method: "Browser.getVersion" }),
    JSON.stringify({ id: 1 }),
    JSON.stringify({ id: 1, method: "Browser.getVersion", extra: true }),
  ])("refuses a malformed client frame: %s", (frame) => {
    const { route, browser, client } = router();
    expect(route.fromClient(client().handle, frame)).toBe(false);
    expect(browser).toEqual([]);
  });
});

describe("the bridge process", () => {
  it("relays both ways over a private socket, with no browser port", async () => {
    const run = bridge();
    await listening(run.socket);
    expect(lstatSync(run.socket).mode & 0o777).toBe(0o600);
    const client = await new Client(run.socket).open();
    client.send({ id: 1, method: "Browser.getVersion" });
    expect(await client.reply(1)).toEqual({
      id: 1,
      result: { product: "Fake/1", protocolVersion: "1.3" },
    });
    client.send({ id: 2, method: "Target.attachToTarget", params: { targetId: "T" } });
    const reply = await client.reply(2);
    expect(reply).toBeDefined();
    if (reply === undefined) throw new Error("The attach reply is missing.");
    const result = reply.result;
    expect(result).toMatchObject({ sessionId: expect.any(String) });
    if (typeof result !== "object" || result === null || !("sessionId" in result))
      throw new Error("The attach reply has no session.");
    const { sessionId } = result;
    expect(typeof sessionId).toBe("string");
    client.send({ id: 3, method: "Fixture.emit", params: { text: "hello", sessionId } });
    await expect
      .poll(() => client.frames.find((frame) => frame.method === "Fixture.event"))
      .toEqual({ method: "Fixture.event", params: { text: "hello" }, sessionId });
  });

  it("serves clients concurrently without crossing replies", async () => {
    const run = bridge();
    await listening(run.socket);
    const a = await new Client(run.socket).open();
    const b = await new Client(run.socket).open();
    a.send({ id: 1, method: "Fixture.echo", params: { who: "a" } });
    b.send({ id: 1, method: "Fixture.echo", params: { who: "b" } });
    expect(await a.reply(1)).toEqual({ id: 1, result: { who: "a" } });
    expect(await b.reply(1)).toEqual({ id: 1, result: { who: "b" } });
    expect(a.frames).toHaveLength(1);
    expect(b.frames).toHaveLength(1);
  });

  it("detaches a disconnected client's sessions in the browser", async () => {
    const run = bridge();
    await listening(run.socket);
    const client = await new Client(run.socket).open();
    client.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "T" } });
    const reply = await client.reply(1);
    expect(reply).toBeDefined();
    if (reply === undefined) throw new Error("The attach reply is missing.");
    const result = reply.result;
    expect(result).toMatchObject({ sessionId: expect.any(String) });
    if (typeof result !== "object" || result === null || !("sessionId" in result))
      throw new Error("The attach reply has no session.");
    const { sessionId } = result;
    expect(typeof sessionId).toBe("string");
    client.connection.destroy();
    await expect
      .poll(() => received(run.log).find((message) => message.method === "Target.detachFromTarget"))
      .toMatchObject({ params: { sessionId } });
  });

  it("drops a client that sends an oversized frame, without passing any of it on", async () => {
    const run = bridge();
    await listening(run.socket);
    const client = await new Client(run.socket).open();
    client.connection.write(
      `{"id":1,"method":"Fixture.echo","params":{"pad":"${"x".repeat(CLIENT_FRAME_LIMIT_BYTES)}"}}\0`,
    );
    await expect.poll(() => client.closed).toBe(true);
    const next = await new Client(run.socket).open();
    next.send({ id: 1, method: "Fixture.echo", params: { ok: true } });
    expect(await next.reply(1)).toEqual({ id: 1, result: { ok: true } });
    expect(received(run.log).map((message) => message.params)).toEqual([{ ok: true }]);
    expect(logged(run.log).some((entry) => "partial" in entry)).toBe(false);
  });

  it("drops an oversized browser frame and keeps relaying after it", async () => {
    const run = bridge();
    await listening(run.socket);
    const client = await new Client(run.socket).open();
    client.send({ id: 1, method: "Fixture.big", params: { size: BROWSER_FRAME_LIMIT_BYTES } });
    client.send({ id: 2, method: "Fixture.big", params: { size: 10 } });
    expect(await client.reply(2)).toEqual({ id: 2, result: { data: "x".repeat(10) } });
    expect(client.frames.some((frame) => frame.id === 1)).toBe(false);
    expect(client.closed).toBe(false);
    client.connection.destroy();
    await expect.poll(() => client.closed).toBe(true);
    const next = await new Client(run.socket).open();
    next.send({ id: 1, method: "Browser.getVersion" });
    expect(await next.reply(1)).toEqual({
      id: 1,
      result: { product: "Fake/1", protocolVersion: "1.3" },
    });
    expect(next.frames).toHaveLength(1);
  });

  it("refuses connections beyond its client limit", async () => {
    const run = bridge();
    await listening(run.socket);
    const clients = await Promise.all(
      Array.from({ length: BRIDGE_CLIENT_LIMIT }, () => new Client(run.socket).open()),
    );
    const extra = await new Client(run.socket).open();
    await expect.poll(() => extra.closed).toBe(true);
    clients[0]?.send({ id: 1, method: "Browser.getVersion" });
    expect(await clients[0]?.reply(1)).toMatchObject({ id: 1 });
  });

  it("refuses to take over a live socket and launches nothing", async () => {
    const { socket, log } = paths();
    const server = createServer();
    server.listen(socket);
    await once(server, "listening");
    cleanups.push(() => server.close());
    await expect(
      runCdpBridge({ socketPath: socket, command: process.execPath, args: [fake, log] }),
    ).rejects.toThrow("already in use");
    expect(existsSync(log)).toBe(false);
    expect(lstatSync(socket).isSocket()).toBe(true);
  });

  it("refuses a path that is not a socket", async () => {
    const { socket, log } = paths();
    writeFileSync(socket, "keep me");
    await expect(
      runCdpBridge({ socketPath: socket, command: process.execPath, args: [fake, log] }),
    ).rejects.toThrow("not a socket");
    expect(readFileSync(socket, "utf8")).toBe("keep me");
  });

  it("replaces a stale socket nothing is listening on", async () => {
    const { socket } = paths();
    const holder = spawn(process.execPath, [
      "-e",
      `require('node:net').createServer().listen(${JSON.stringify(socket)}, () => console.log('up'))`,
    ]);
    await once(holder.stdout, "data");
    holder.kill("SIGKILL");
    await once(holder, "exit");
    expect(lstatSync(socket).isSocket()).toBe(true);
    const log = join(root, `stale-${sequence}.jsonl`);
    const stop = new AbortController();
    cleanups.push(() => stop.abort());
    const exited = runCdpBridge({
      socketPath: socket,
      command: process.execPath,
      args: [fake, log],
      stop: stop.signal,
    });
    await expect.poll(() => logged(log).length).toBeGreaterThan(0);
    expect(await probeCdpBridge(socket)).toBe(true);
    stop.abort();
    await exited;
  });

  it("closes and removes its socket when the browser exits", async () => {
    const run = bridge();
    await listening(run.socket);
    const client = await new Client(run.socket).open();
    client.send({ id: 1, method: "Fixture.exit", params: { code: 3 } });
    expect(await run.exited).toBe(3);
    expect(existsSync(run.socket)).toBe(false);
    await expect.poll(() => client.closed).toBe(true);
  });

  it("stops the browser and waits for it before exiting", async () => {
    const run = bridge();
    await listening(run.socket);
    await expect.poll(() => logged(run.log).length).toBeGreaterThan(0);
    const started = Date.now();
    run.stop.abort();
    await run.exited;
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    const pid = Number(logged(run.log)[0]?.launched);
    expect(logged(run.log)).toContainEqual({ signal: "SIGTERM" });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(run.socket)).toBe(false);
  });

  it("kills only its own browser when it ignores SIGTERM past the grace period", async () => {
    const run = bridge("stubborn", 300);
    await listening(run.socket);
    await expect.poll(() => logged(run.log).length).toBeGreaterThan(0);
    const started = Date.now();
    run.stop.abort();
    await run.exited;
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    const pid = Number(logged(run.log)[0]?.launched);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("the readiness probe", () => {
  it("passes only for a bridge whose browser answers", async () => {
    const run = bridge();
    await listening(run.socket);
    expect(await probeCdpBridge(run.socket)).toBe(true);
    expect(received(run.log).map((message) => message.method)).toEqual(["Browser.getVersion"]);
  });

  it("fails for a missing socket", async () => {
    expect(await probeCdpBridge(paths().socket)).toBe(false);
  });

  it("fails within its deadline when the browser never answers", async () => {
    const run = bridge("silent");
    await listening(run.socket);
    const started = Date.now();
    expect(await probeCdpBridge(run.socket, 300)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("fails for a listener that answers with something else", async () => {
    const { socket } = paths();
    const server = createServer((connection) => {
      connection.on("data", () => connection.write('{"id":1,"result":{}}\0'));
    });
    server.listen(socket);
    await once(server, "listening");
    cleanups.push(() => server.close());
    expect(await probeCdpBridge(socket)).toBe(false);
  });
});

describe("the bundled driver", () => {
  it("runs the bridge and the probe, and forwards SIGTERM to the browser", async () => {
    const { socket, log } = paths();
    const child = spawn(
      process.execPath,
      [driver, "--cdp-bridge", socket, "--", process.execPath, fake, log],
      { stdio: "ignore" },
    );
    cleanups.push(() => child.kill("SIGKILL"));
    await listening(socket);
    await expect
      .poll(
        () =>
          spawnSync(process.execPath, [driver, "--cdp-probe", socket], { stdio: "ignore" }).status,
      )
      .toBe(0);
    child.kill("SIGTERM");
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
    expect(logged(log)).toContainEqual({ signal: "SIGTERM" });
    expect(existsSync(socket)).toBe(false);
    expect(spawnSync(process.execPath, [driver, "--cdp-probe", socket]).status).toBe(1);
  });

  it.each([
    ["--cdp-bridge"],
    ["--cdp-bridge", "relative.sock", "--", "browser"],
    ["--cdp-bridge", "/tmp/x.sock", "browser"],
    ["--cdp-bridge", "/tmp/x.sock", "--"],
    ["--cdp-probe"],
    ["--cdp-probe", "/tmp/x.sock", "extra"],
  ])("refuses malformed bridge arguments %j without launching", (...args) => {
    const run = spawnSync(process.execPath, [driver, ...args], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
  });
});
