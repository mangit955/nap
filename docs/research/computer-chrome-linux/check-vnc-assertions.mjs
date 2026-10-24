// Free retained-frame and installed-library checks. No browser, Docker or network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(process.argv[2] ?? "/tmp/nap-vnc-assertion-check");
mkdirSync(output, { recursive: true });
const source = readFileSync(new URL("./check-vnc.mjs", import.meta.url), "utf8");
const report = { network: false, docker: false, browser: false, failures: [] };
try {
  const start = source.indexOf("window.frame=()=>{");
  const end = source.indexOf("window.attackRfb=", start);
  assert(start >= 0 && end > start);
  const observe = source.slice(start, end);
  const readPixels = (name) =>
    new Uint8ClampedArray(
      execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          new URL(`./vnc/verified/${name}`, import.meta.url).pathname,
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgba",
          "-",
        ],
        { timeout: 10000, maxBuffer: 4_000_000 },
      ),
    );
  const frame = (data) => {
    const window = {};
    const canvas = {
      width: 1024,
      height: 768,
      getContext: () => ({ getImageData: () => ({ data }) }),
      toDataURL: () => "",
    };
    runInNewContext(
      observe,
      { window, document: { querySelector: () => canvas } },
      { timeout: 1000 },
    );
    return window.frame();
  };
  const baselinePixels = readPixels("vnc-adversarial.png");
  const baseline = frame(baselinePixels);
  const physical = frame(readPixels("vnc-after-physical.png"));
  assert(
    Number.isFinite(baseline.resultGreenPixels),
    "Frame observations must quantify the result region.",
  );
  assert(physical.resultGreenPixels > baseline.resultGreenPixels + 100);
  assert.equal(baseline.resultGreenPixels > baseline.resultGreenPixels + 100, false);
  const background = new Uint8ClampedArray(baselinePixels);
  for (let y = 400; y < 450; y++)
    for (let x = 700; x < 800; x++) {
      const i = (y * 1024 + x) * 4;
      background.set([120, 230, 150, 255], i);
    }
  assert.equal(frame(background).resultGreenPixels, baseline.resultGreenPixels);
  const cursor = new Uint8ClampedArray(baselinePixels);
  for (let x = 480; x < 500; x++) cursor.set([120, 230, 150, 255], (295 * 1024 + x) * 4);
  assert(frame(cursor).resultGreenPixels <= baseline.resultGreenPixels + 20);
  assert.equal(frame(cursor).resultGreenPixels > baseline.resultGreenPixels + 100, false);
  report.frames = {
    baseline: baseline.resultGreenPixels,
    physical: physical.resultGreenPixels,
    frozenRejected: true,
    backgroundRejected: true,
    smallCursorRejected: true,
  };
} catch (error) {
  report.failures.push(`Frame guard: ${String(error)}`);
}
try {
  const start = source.indexOf("function waitForPage(");
  assert(start >= 0, "Use the bounded Playwright wait helper.");
  const end = source.indexOf("\n}", start) + 2;
  const wait = runInNewContext(`(${source.slice(start, end)})`, {}, { timeout: 1000 });
  const require = createRequire(import.meta.url);
  const { Frame } = require(
    resolve(root, "apps/napbench/node_modules/playwright-core/lib/client/frame.js"),
  );
  const { TimeoutSettings } = require(
    resolve(root, "apps/napbench/node_modules/playwright-core/lib/client/timeoutSettings.js"),
  );
  const settings = new TimeoutSettings({ isDebugMode: () => false });
  report.waits = [];
  for (const timeout of [12000, 15000, undefined]) {
    let sent;
    const stop = new Error("Captured actual channel arguments");
    const fake = {
      _timeout: (options) => settings.timeout(options),
      _channel: {
        waitForFunction: async (params) => {
          sent = params;
          throw stop;
        },
      },
    };
    const page = {
      waitForFunction: (...args) => Frame.prototype.waitForFunction.apply(fake, args),
    };
    await assert.rejects(
      wait(page, () => false, timeout),
      (error) => error === stop,
    );
    assert.equal(sent.timeout, timeout ?? 15000);
    report.waits.push(sent.timeout);
  }
} catch (error) {
  report.failures.push(`Wait guard: ${String(error)}`);
}
report.ok = report.failures.length === 0;
writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
assert.equal(report.ok, true, report.failures.join("\n"));
console.log(
  "PASS: retained marker pixels reject stale/background/cursor observations; installed Playwright receives explicit deadlines.",
);
