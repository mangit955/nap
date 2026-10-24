// Run against a dedicated headless Chrome, never the logged-in Devin browser.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const endpoint = process.argv[2] ?? "http://127.0.0.1:9337";
const pageUrl = process.argv[3] ?? "http://127.0.0.1:4319/docs/computer-use-mockup.html";
assert(new URL(endpoint).port !== "9223", "Do not drive the passive Devin browser");
const target = await fetch(`${endpoint}/json/new?${encodeURIComponent(pageUrl)}`, {
  method: "PUT",
}).then((r) => r.json());
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
const output = fileURLToPath(new URL(".", import.meta.url));
await mkdir(output, { recursive: true });
async function shot(name) {
  const { data } = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(`${output}${name}.png`, Buffer.from(data, "base64"));
}
try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: pageUrl });
  for (let i = 0; i < 50; i++) {
    if (await evaluate("document.readyState === 'complete' && typeof seek === 'function'")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(
    await evaluate("document.querySelector('[role=application]').getAttribute('aria-label')"),
    "Remote computer",
  );
  assert.equal(
    await evaluate("document.querySelector('[aria-label=\"Session timeline\"]').max"),
    "3",
  );
  await shot("nap-computer-live");
  await evaluate("document.querySelector('#previous').click()");
  assert.equal(
    await evaluate("document.querySelector('#live-copy').textContent"),
    "Go to live desktop",
  );
  await shot("nap-computer-history");
  await evaluate("document.querySelector('#live').click();document.querySelector('#busy').click()");
  assert.equal(await evaluate("document.querySelector('#take-control').disabled"), true);
  assert.match(
    await evaluate("document.querySelector('#control-hint').textContent"),
    /finishes this turn/,
  );
  await evaluate(
    "document.querySelector('#busy').click();document.querySelector('#take-control').click()",
  );
  assert.equal(
    await evaluate("document.querySelector('#control-hint').textContent"),
    "Click anywhere to drive the computer",
  );
  await shot("nap-computer-driving");
  for (const state of ["waiting", "starting", "connecting", "failed", "empty"]) {
    await evaluate(`setState('${state}')`);
    assert.equal(
      await evaluate("getComputedStyle(document.querySelector('.state')).display"),
      "flex",
    );
    if (state === "failed")
      assert.equal(await evaluate("document.querySelector('#retry').hidden"), false);
    await shot(`nap-computer-${state}`);
  }
  await evaluate("setState('live');document.querySelector('#test-app').click()");
  assert.equal(await evaluate("document.querySelector('#plan').hidden"), false);
  assert.equal(await evaluate("document.querySelector('#repair-status').textContent"), "");
  await evaluate("document.querySelector('#fix').click()");
  assert.match(
    await evaluate("document.querySelector('#repair-status').textContent"),
    /queued by you/,
  );
  await evaluate("document.querySelector('#result-record').click()");
  assert.equal(await evaluate("document.querySelector('dialog').open"), true);
  await shot("nap-recording-viewer");
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "ArrowRight",
    code: "ArrowRight",
    modifiers: 8,
  });
  assert.equal(
    await evaluate("document.querySelector('#chapter-copy').textContent"),
    "Required fields",
  );
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space" });
  assert.equal(
    await evaluate("document.querySelector('#play').getAttribute('aria-label')"),
    "Pause recording",
  );
  await evaluate(
    "document.querySelector('#play').click();document.querySelector('#dom-tab').click();document.querySelector('#console-button').click()",
  );
  assert.equal(await evaluate("document.querySelector('#console').hidden"), false);
  await shot("nap-dom-replay-concept");
  await evaluate("document.querySelector('#close-record').click()");
  assert.equal(await evaluate("document.activeElement.id"), "result-record");
  await send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-reduced-transparency", value: "reduce" },
    ],
  });
  assert.equal(
    await evaluate("getComputedStyle(document.querySelector('.dot')).animationName"),
    "none",
  );
  assert.equal(
    await evaluate("getComputedStyle(document.querySelector('.controls')).backdropFilter"),
    "none",
  );
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await shot("nap-computer-phone");
  await evaluate("document.querySelector('#result-record').click()");
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await shot("nap-recording-phone");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: history, takeover, connection states, explicit repair, chapters, keyboard, DOM concept, focus, reduced preferences, 390px overflow; 12 screenshots.",
  );
} finally {
  await fetch(`${endpoint}/json/close/${target.id}`);
  ws.close();
}
