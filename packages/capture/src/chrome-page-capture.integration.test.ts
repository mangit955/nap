import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChromePageCapture } from "./chrome-page-capture.ts";

/**
 * The half no fake can prove: that a real browser launches, loads a page and returns a PNG.
 *
 * Integration rather than unit because it needs a browser on the machine — but unlike the rest
 * of that suite it costs nothing and touches no network: the page it photographs is served from
 * this process on a loopback port. `NAP_CHROME_PATH` names the binary, exactly as the API does;
 * with none configured there is nothing to test and the suite says so rather than failing.
 */

const CHROME = process.env.NAP_CHROME_PATH;
const PNG_MAGIC = [137, 80, 78, 71];

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body style='background:#123456'><h1>a habit tracker</h1></body></html>");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe.skipIf(CHROME === undefined)("capturing a page with a real browser", () => {
  it("returns PNG bytes of the page", async () => {
    const capture = new ChromePageCapture({ executablePath: CHROME ?? "" });

    const shot = await capture.capture(origin, { width: 600, height: 400 });

    expect(shot.ok).toBe(true);
    // The magic number, because that is the only claim a caller makes about these bytes: they
    // are a PNG. Anything about the pixels would be a test of Chrome's renderer.
    expect(shot.ok && [...shot.value.slice(0, 4)]).toEqual(PNG_MAGIC);
  });

  it("reports a page nothing is serving rather than throwing", async () => {
    // The whole reason the port returns a result: a sandbox reclaimed mid-turn is an ordinary
    // outcome, and a thrown error here would take a completed turn down with it.
    const capture = new ChromePageCapture({ executablePath: CHROME ?? "" });

    const shot = await capture.capture("http://127.0.0.1:1/", { timeoutMs: 5_000 });

    expect(shot).toMatchObject({ ok: false });
  });

  it("reports a browser that is not there", async () => {
    const capture = new ChromePageCapture({ executablePath: "/nowhere/chrome" });

    expect(await capture.capture(origin)).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });
});
