// Dedicated local Chrome only. This script never opens the Devin browser.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const endpoint = process.argv[2] ?? "http://127.0.0.1:9348";
assert.equal(new URL(endpoint).hostname, "127.0.0.1");
assert.notEqual(new URL(endpoint).port, "9223");
const target = await fetch(`${endpoint}/json/new?http://127.0.0.1:4321`, { method: "PUT" }).then(
  (response) => response.json(),
);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 0;
const pending = new Map();
const errors = [];
ws.onmessage = ({ data }) => {
  const message = JSON.parse(String(data));
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timeout);
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
  else entry.resolve(message.result);
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out: ${method}`));
    }, 15000);
    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function wait(expression) {
  for (let index = 0; index < 60; index++) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Not ready: ${expression}`);
}
async function click(text) {
  assert.equal(
    await evaluate(
      `(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(text)}) || b.getAttribute('aria-label') === ${JSON.stringify(text)}); if (!button || button.disabled) return false; button.focus(); button.click(); return true; })()`,
    ),
    true,
    text,
  );
  await evaluate("new Promise(requestAnimationFrame)");
}
async function key(key, code = key, modifiers = 0) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
}
const directory = fileURLToPath(new URL("./", import.meta.url));
async function shot(name) {
  const { data } = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(`${directory}${name}.png`, Buffer.from(data, "base64"));
}
try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: "http://127.0.0.1:4321" });
  await wait("document.querySelector('video')?.readyState >= 1");
  assert.equal(
    await evaluate("document.activeElement.getAttribute('aria-label')"),
    "Close test recording viewer",
  );
  assert.equal(await evaluate("document.querySelector('#root').inert"), true);
  assert.equal(await evaluate("document.querySelector('video').crossOrigin"), "use-credentials");
  assert.equal(
    await evaluate(
      "(() => { const close = document.querySelector('[aria-label=\"Close test recording viewer\"]'); const icon = close.querySelector('svg').getBoundingClientRect(); return icon.width === 16 && icon.height === 16 && close.getBoundingClientRect().right <= innerWidth; })()",
    ),
    true,
  );
  await click("Test 1");
  assert.equal(await evaluate("document.querySelector('video').currentTime"), 2);
  await shot("nap-viewer-desktop");
  await evaluate("document.querySelector('video').focus()");
  await key(" ", "Space");
  await wait("document.querySelector('video').currentTime > 2.1");
  await key(" ", "Space");
  assert.equal(await evaluate("document.querySelector('video').paused"), true);
  await key("ArrowRight", "ArrowRight", 8);
  await wait("document.querySelector('video').currentTime === 5");
  await click("Loop current chapter");
  await evaluate(
    "document.querySelector('video').currentTime = 7.9; document.querySelector('video').focus()",
  );
  await key(" ", "Space");
  await wait("document.querySelector('video').currentTime < 6");
  await key(" ", "Space");
  assert.equal(await evaluate("document.querySelector('video').paused"), true);
  await click("Full screen");
  await wait("document.fullscreenElement !== null");
  await evaluate("document.exitFullscreen()");
  await wait("document.fullscreenElement === null");
  const glass = await evaluate(
    "(() => { const d = document.querySelector('[role=dialog]'); const s = getComputedStyle(d); return { background: s.backgroundColor, filter: s.backdropFilter, radius: s.borderRadius }; })()",
  );
  assert.match(glass.filter, /blur\(16px\) saturate\(1.08\)/);
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-transparency", value: "reduce" },
      { name: "prefers-reduced-motion", value: "reduce" },
    ],
  });
  await evaluate("new Promise(requestAnimationFrame)");
  assert.equal(
    await evaluate("getComputedStyle(document.querySelector('[role=dialog]')).backdropFilter"),
    "none",
  );
  assert.equal(
    await evaluate(
      "(() => { const d = document.querySelector('[role=dialog]'); return d.scrollWidth <= d.clientWidth && d.getBoundingClientRect().right <= innerWidth; })()",
    ),
    true,
  );
  await shot("nap-viewer-phone-reduced");
  await click("Close test recording viewer");
  assert.equal(await evaluate("document.querySelector('#root').inert"), false);
  await click("View empty state");
  await wait(
    "document.body.textContent.includes('No browser test recordings in this session yet')",
  );
  await shot("nap-viewer-empty");
  await key("Escape");
  await wait("!document.querySelector('[role=dialog]')");
  assert.equal(await evaluate("document.activeElement.textContent"), "View empty state");
  await click("View unavailable recording");
  await wait("document.querySelector('[role=alert]') !== null");
  await shot("nap-viewer-unavailable");
  assert.deepEqual(errors, []);
  const report = {
    reviewedAt: new Date().toISOString(),
    browser: await send("Browser.getVersion"),
    glass,
    checks: [
      "actual native playback advances",
      "Space pauses",
      "Shift+Arrow seeks",
      "native ended loops chapter",
      "fullscreen entry and exit",
      "owner-cookie video attributes",
      "modal focus and inert background",
      "Escape closes and restores focus",
      "390px overflow",
      "reduced transparency",
      "empty state",
      "unavailable source",
    ],
    errors,
  };
  await writeFile(`${directory}browser-report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log("Recording viewer browser checks passed");
} finally {
  ws.close();
  await fetch(`${endpoint}/json/close/${target.id}`);
}
