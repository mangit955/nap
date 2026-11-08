/**
 * Dragging rows between the sidebar's shelves, proven in a real Chrome.
 *
 * jsdom lays nothing out, so every rule about *where* a drop lands is checked in
 * `sidebar-drop.test.ts` against a list rather than pixels — and this file is what shows the
 * pixels agree. It bundles `testing/sidebar-fixture.tsx` (the real sidebar, the real navigation
 * hook, an in-memory server), compiles the real stylesheet with Tailwind, serves both on a
 * loopback port and drives the page with real mouse events over the DevTools protocol.
 *
 * Needs: a Chrome at `NAP_CHROME_PATH`, and `bun` on the PATH to bundle. No network, no
 * credentials, no money. It skips without the Chrome.
 *
 * Set `NAP_SIDEBAR_PROOF_DIR` to keep the evidence: a screenshot at each step and, when
 * `ffmpeg` is on the PATH, a recording of the whole run. `docs/assets/sidebar/drag/` holds the
 * committed copy.
 *
 * The protocol is spoken directly over a WebSocket rather than through Playwright, which belongs
 * to apps/napbench alone (`test/architecture.ts`).
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CHROME = process.env.NAP_CHROME_PATH;
const PROOF = process.env.NAP_SIDEBAR_PROOF_DIR;
const WEB = join(import.meta.dirname, "..", "..");
const WIDTH = 288;
const HEIGHT = 720;

/** One DevTools protocol connection to one page. */
class Page {
  #id = 0;
  #waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>();
  /** What the page threw or logged as an error, so a timeout can say why. */
  readonly errors: string[] = [];
  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
      };
      if (message.id !== undefined) {
        const waiter = this.#waiting.get(message.id);
        this.#waiting.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result);
      } else if (message.method) {
        for (const listener of this.#listeners.get(message.method) ?? [])
          listener(message.params ?? {});
      }
    });
  }
  send<T = Record<string, unknown>>(method: string, params: object = {}): Promise<T> {
    const id = ++this.#id;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) =>
      this.#waiting.set(id, { resolve: resolve as (value: unknown) => void, reject }),
    );
  }
  on(method: string, listener: (params: Record<string, unknown>) => void) {
    this.#listeners.set(method, [...(this.#listeners.get(method) ?? []), listener]);
  }
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{
      result: { value: T };
      exceptionDetails?: { text: string };
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`${expression}: ${result.exceptionDetails.text}`);
    return result.result.value;
  }
  async waitFor(expression: string, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(`Boolean(${expression})`)) return;
      await pause(25);
    }
    throw new Error(`Timed out waiting for ${expression}\n${this.errors.join("\n")}`);
  }
  mouse(type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number) {
    return this.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" ? "none" : "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The page-side expression for a session's row: the `<li>` whose link carries this name. */
const rowOf = (name: string) =>
  `[...document.querySelectorAll("a[data-session-link]")].find((a) => a.textContent.includes(${JSON.stringify(name)}))?.closest("[data-row-id]")`;
type Rect = { x: number; y: number; width: number; height: number };
const centre = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const rectOf = (page: Page, element: string) =>
  page.evaluate<Rect>(
    `(() => { const r = (${element}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
  );

type Write = { method: string; path: string; body: unknown };
const writes = (page: Page) => page.evaluate<Write[]>("window.__navigation.requests");

let server: Server;
let origin: string;
let chrome: ChildProcess;
let page: Page;
let scratch: string;
let shot = 0;
const frames: { file: string; at: number }[] = [];

async function screenshot(name: string) {
  if (!PROOF) return;
  const { data } = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  shot += 1;
  writeFileSync(
    join(PROOF, `${String(shot).padStart(2, "0")}-${name}.png`),
    Buffer.from(data, "base64"),
  );
}

/** Presses on `from`, moves past the activation distance, then to wherever `to` says. */
async function drag(from: string, to: () => Promise<{ x: number; y: number }>, name: string) {
  const start = centre(await rectOf(page, from));
  await page.mouse("mouseMoved", start.x, start.y);
  await page.mouse("mousePressed", start.x, start.y);
  for (let step = 1; step <= 4; step += 1) {
    await page.mouse("mouseMoved", start.x, start.y + step * 3);
    await pause(16);
  }
  await page.waitFor(`document.querySelector("[data-boundary]")`);
  const end = await to();
  const steps = 12;
  for (let step = 1; step <= steps; step += 1) {
    const y = start.y + 12 + ((end.y - start.y - 12) * step) / steps;
    await page.mouse("mouseMoved", start.x, y);
    await pause(16);
  }
  await pause(150);
  await screenshot(`${name}-dragging`);
  await page.mouse("mouseReleased", start.x, end.y);
  await pause(350);
  await screenshot(`${name}-dropped`);
}

beforeAll(async () => {
  if (!CHROME) return;
  scratch = mkdtempSync(join(tmpdir(), "nap-sidebar-drag-"));
  const site = join(scratch, "site");
  mkdirSync(site);
  if (PROOF) mkdirSync(PROOF, { recursive: true });

  const built = spawnSync(
    "bun",
    [
      "build",
      join(WEB, "src", "testing", "sidebar-fixture.tsx"),
      "--outdir",
      site,
      "--target",
      "browser",
      "--splitting",
      "--production",
      "--define",
      'process.env.NEXT_PUBLIC_API_URL="http://fixture.invalid"',
    ],
    { encoding: "utf8" },
  );
  if (built.status !== 0) throw new Error(`bun build failed: ${built.stderr}`);

  const require = createRequire(join(WEB, "package.json"));
  const tailwind = require("@tailwindcss/postcss");
  const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
  const from = join(WEB, "src", "app", "globals.css");
  const css = await postcss([tailwind({ base: WEB })]).process(readFileSync(from, "utf8"), {
    from,
  });
  writeFileSync(join(site, "app.css"), css.css);
  writeFileSync(
    join(site, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head>
<body class="bg-surface text-ink antialiased"><div id="root"></div><script type="module" src="/sidebar-fixture.js"></script></body></html>`,
  );

  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
  };
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    const file = join(site, path === "/" ? "index.html" : path);
    if (!file.startsWith(site) || !existsSync(file)) {
      response.writeHead(404);
      response.end("not here");
      return;
    }
    response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    response.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${address.port}`;

  const profile = join(scratch, "profile");
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      `--window-size=${WIDTH},${HEIGHT}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const portFile = join(profile, "DevToolsActivePort");
  for (let tries = 0; !existsSync(portFile) && tries < 200; tries += 1) await pause(50);
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const target = targets.find((item) => item.type === "page");
  if (!target) throw new Error("Chrome opened no page");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  page = new Page(socket);
  page.on("Runtime.exceptionThrown", (params) => {
    const details = params.exceptionDetails as {
      exception?: { description?: string };
      text: string;
    };
    page.errors.push(details.exception?.description ?? details.text);
  });
  page.on("Runtime.consoleAPICalled", (params) => {
    if (params.type !== "error") return;
    const args = params.args as { value?: unknown; description?: string }[];
    page.errors.push(args.map((arg) => String(arg.value ?? arg.description)).join(" "));
  });
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await page.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  if (PROOF) {
    page.on("Page.screencastFrame", (params) => {
      const file = join(scratch, `frame-${String(frames.length).padStart(5, "0")}.jpg`);
      writeFileSync(file, Buffer.from(String(params.data), "base64"));
      frames.push({ file, at: Number((params.metadata as { timestamp: number }).timestamp) });
      void page.send("Page.screencastFrameAck", { sessionId: params.sessionId });
    });
    await page.send("Page.startScreencast", { format: "jpeg", quality: 85, everyNthFrame: 1 });
  }
}, 60_000);

afterAll(async () => {
  if (!CHROME) return;
  if (PROOF && frames.length > 1) {
    await page.send("Page.stopScreencast");
    // Frames arrive when something changed, so each is held until the next one came.
    const list = frames
      .map((frame, index) => {
        const next = frames[index + 1]?.at ?? frame.at + 0.5;
        return `file '${frame.file}'\nduration ${Math.max(0.01, next - frame.at).toFixed(3)}`;
      })
      .join("\n");
    writeFileSync(join(scratch, "frames.txt"), `${list}\nfile '${frames.at(-1)?.file}'\n`);
    spawnSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        join(scratch, "frames.txt"),
        "-vf",
        "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v",
        "libvpx-vp9",
        "-b:v",
        "0",
        "-crf",
        "34",
        join(PROOF, "drag.webm"),
      ],
      { stdio: "ignore" },
    );
  }
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill();
    await exited;
  }
  server?.close();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
});

describe.skipIf(CHROME === undefined)("dragging between the sidebar's shelves, in Chrome", () => {
  beforeEach(async () => {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 2,
      mobile: false,
    });
    // A fresh page is a fresh in-memory server, so each case starts from the same six rows.
    await page.send("Page.navigate", { url: `${origin}/` });
    await page.waitFor(`${rowOf("Pricing page")}`);
    // The drag layer is fetched beside the list; dnd-kit's own description says it has arrived.
    await page.waitFor(`document.querySelector("[id^='DndDescribedBy']")`);
  });

  it("pins a row dropped above the inbox, with the boundaries drawn only while it is held", async () => {
    expect(await page.evaluate<number>(`document.querySelectorAll("[data-boundary]").length`)).toBe(
      0,
    );
    await screenshot("pin-before");
    await drag(
      rowOf("Search results"),
      async () =>
        centre(await rectOf(page, `document.querySelector("[data-boundary='pinned-divider']")`)),
      "pin",
    );
    expect(await page.evaluate<number>(`document.querySelectorAll("[data-boundary]").length`)).toBe(
      0,
    );
    await page.waitFor(`${rowOf("Search results")}?.querySelector("[aria-label='Pinned']")`);
    const sent = await writes(page);
    expect(sent[0]).toMatchObject({
      method: "PATCH",
      body: { change: { kind: "pin", pinned: true } },
    });
    expect(sent[1]).toMatchObject({ path: "/sessions/order", body: { section: "pinned" } });
    // The pinned row is drawn first, above the inbox.
    expect(
      await page.evaluate<string>(
        `document.querySelector("[aria-label='Inbox sessions'] a[data-session-link]").textContent`,
      ),
    ).toContain("Search results");
  });

  it("settles a row dropped on the Settled shelf", async () => {
    await drag(
      rowOf("Checkout flow"),
      async () =>
        centre(
          await rectOf(page, `document.querySelector("section[aria-label='Settled'] button")`),
        ),
      "settle",
    );
    await page.waitFor(`!${rowOf("Checkout flow")}`);
    expect(
      await page.evaluate<string>(
        `document.querySelector("section[aria-label='Settled'] button").textContent`,
      ),
    ).toContain("Settled (3)");
    expect((await writes(page))[0]).toMatchObject({
      body: { change: { kind: "done", value: true } },
    });
  });

  it("un-settles a settled row dropped into the inbox, where it was let go", async () => {
    await page.evaluate(`document.querySelector("section[aria-label='Settled'] button").click()`);
    await page.waitFor(rowOf("Shipped landing page"));
    await drag(
      rowOf("Shipped landing page"),
      async () => centre(await rectOf(page, rowOf("Checkout flow"))),
      "unsettle",
    );
    await page.waitFor(
      `document.querySelector("[aria-label='Inbox sessions']").textContent.includes("Shipped landing page")`,
    );
    const sent = await writes(page);
    expect(sent[0]).toMatchObject({ body: { change: { kind: "done", value: false } } });
    expect(sent[1]).toMatchObject({ path: "/sessions/order", body: { section: "active" } });
  });

  it("reorders within the inbox, and never follows the link of the row it moved", async () => {
    await drag(
      rowOf("Pricing page"),
      async () => centre(await rectOf(page, rowOf("Checkout flow"))),
      "reorder",
    );
    const names = await page.evaluate<string[]>(
      `[...document.querySelectorAll("[aria-label='Inbox sessions'] a[data-session-link]")].map((a) => a.textContent.match(/(Header polish|Checkout flow|Search results|Pricing page)/)?.[0])`,
    );
    expect(names).toEqual(["Header polish", "Pricing page", "Checkout flow", "Search results"]);
    expect((await writes(page))[0]).toMatchObject({
      path: "/sessions/order",
      body: { section: "active" },
    });
    // The click that ends a drag lands on the row's link; following it would have left the page.
    await pause(400);
    expect(await page.evaluate<string>("location.pathname")).toBe("/");
  });

  it("keeps Copy and Snooze reachable while the pointer crosses into their submenus", async () => {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 900,
      height: HEIGHT,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await page.evaluate(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    await page.evaluate(
      `Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { window.__copied = text; } } })`,
    );
    for (const [owner, item] of [
      ["copy", "Branch"],
      ["snooze", "In 1 hour"],
    ]) {
      const point = centre(await rectOf(page, rowOf("Header polish")));
      for (const type of ["mousePressed", "mouseReleased"]) {
        await page.send("Input.dispatchMouseEvent", {
          type,
          x: point.x,
          y: point.y,
          button: "right",
          buttons: type === "mousePressed" ? 2 : 0,
          clickCount: 1,
        });
      }
      const parent = `document.querySelector('[role="menuitem"][data-submenu="${owner}"]')`;
      await page.waitFor(parent);
      const start = centre(await rectOf(page, parent));
      await page.mouse("mouseMoved", start.x, start.y);
      const nested = `document.querySelector('[role="menu"][aria-label="${owner === "copy" ? "Copy" : "Snooze"}"]')`;
      await page.waitFor(nested);
      const submenu = await rectOf(page, nested);
      const endX = submenu.x > start.x ? submenu.x + 10 : submenu.x + submenu.width - 10;
      const direction = Math.sign(endX - start.x);
      for (let x = start.x; direction * (endX - x) >= 0; x += direction) {
        await page.mouse("mouseMoved", x, start.y);
      }
      expect(await page.evaluate<boolean>(`Boolean(${nested})`)).toBe(true);
      const target = `[...(${nested}).querySelectorAll('[role="menuitem"]')].find((button) => button.textContent.startsWith(${JSON.stringify(item)}))`;
      const end = centre(await rectOf(page, target));
      await page.mouse("mouseMoved", end.x, end.y);
      await page.mouse("mousePressed", end.x, end.y);
      await page.mouse("mouseReleased", end.x, end.y);
      await page.waitFor(`!document.querySelector('[role="menu"]')`);
    }
    expect(await page.evaluate<string>("window.__copied")).toBe("nap/change-1");
    expect((await writes(page))[0]).toMatchObject({
      body: { change: { kind: "snooze", until: expect.any(String) } },
    });
  });

  it("abandons a drag released in the main content outside the sidebar", async () => {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 900,
      height: HEIGHT,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await page.evaluate(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    const start = centre(await rectOf(page, rowOf("Checkout flow")));
    await page.mouse("mouseMoved", start.x, start.y);
    await page.mouse("mousePressed", start.x, start.y);
    await page.mouse("mouseMoved", start.x, start.y + 12);
    await page.waitFor(`document.querySelector("[data-boundary]")`);
    const shelf = centre(
      await rectOf(page, `document.querySelector("section[aria-label='Settled'] button")`),
    );
    await page.mouse("mouseMoved", 600, shelf.y);
    await pause(200);
    await page.mouse("mouseReleased", 600, shelf.y);
    await pause(350);
    expect(await writes(page)).toEqual([]);
    expect(await page.evaluate<boolean>(`Boolean(${rowOf("Checkout flow")})`)).toBe(true);
  });
});
