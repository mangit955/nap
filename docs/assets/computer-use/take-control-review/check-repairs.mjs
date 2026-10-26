// Dedicated local fixture only. Reports counts, never source JSON or typed text.
import assert from "node:assert/strict";

const endpoint = process.argv[2] ?? "http://127.0.0.1:9356";
const pageUrl = process.argv[3] ?? "http://127.0.0.1:4336";
assert.equal(new URL(endpoint).hostname, "127.0.0.1");
assert.equal(new URL(endpoint).port, "9356", "Use the dedicated repair Chrome port");
assert.equal(new URL(pageUrl).hostname, "127.0.0.1");
const target = await fetch(`${endpoint}/json/new?${encodeURIComponent(pageUrl)}`, {
  method: "PUT",
}).then((response) => response.json());
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
const pending = new Map();
const errors = [];
let nextId = 0;
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
    }, 15_000);
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
  assert.equal(result.exceptionDetails, undefined, "Browser evaluation failed");
  return result.result.value;
}
async function until(expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Browser state did not settle");
}
const counts = 'JSON.parse(document.querySelector("output").dataset.counts)';
const textbox = 'textarea[aria-label="Type on the remote computer"]';
async function pointer(center, clickCount) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...center });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...center,
    button: "left",
    clickCount,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...center,
    button: "left",
    clickCount,
  });
}
async function enter() {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
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
  await until(
    `document.querySelector(${JSON.stringify(textbox)}) && !document.querySelector(${JSON.stringify(textbox)}).disabled`,
  );
  const center = await evaluate(
    `(() => { const r = document.querySelector(${JSON.stringify(textbox)}).getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; })()`,
  );
  await pointer(center, 1);
  await until('document.querySelector(".screen").dataset.driving === "true"');
  await pointer(center, 2);
  await until(`(${counts}).left_click === 1`);
  assert.equal(await evaluate(`(${counts}).double_click ?? 0`), 0);
  console.log("PASS: grant between acquisition clicks forwards one remaining click");

  await pointer(center, 1);
  await until(`(${counts}).left_click === 2`);
  await pointer(center, 2);
  await until(`(${counts}).left_click === 3`);
  assert.equal(await evaluate(`(${counts}).double_click ?? 0`), 0);
  console.log("PASS: detail 2 after the 400ms timer forwards one remaining click");

  await pointer(center, 1);
  await enter();
  await until(`(${counts}).left_click === 4 && (${counts}).key === 1`);
  await pointer(center, 2);
  await until(`(${counts}).left_click === 5`);
  assert.equal(await evaluate(`(${counts}).double_click ?? 0`), 0);
  console.log("PASS: detail 2 after key flush forwards one remaining click");

  await pointer(center, 1);
  await pointer(center, 2);
  await until(`(${counts}).double_click === 1`);
  assert.equal(await evaluate(`(${counts}).left_click`), 5);
  console.log("PASS: pending first click still becomes one double-click action");

  // Synthetic paste exercises React's real ClipboardEvent path. CDP supplies
  // trusted click counts above; it does not measure the host OS click interval.
  await evaluate(
    `(() => { const data = new DataTransfer(); data.setData('text/plain', 'x'.repeat(32000)); document.querySelector(${JSON.stringify(textbox)}).dispatchEvent(new ClipboardEvent('paste', { bubbles:true, cancelable:true, clipboardData:data })); })()`,
  );
  await enter();
  await until(`(${counts}).type === 16 && (${counts}).key === 2`);
  assert.equal(
    await evaluate(`document.querySelector(${JSON.stringify(textbox)}).value.length`),
    0,
  );
  assert.equal(await evaluate('document.querySelector(".screen").dataset.driving'), "true");
  console.log(
    "PASS: maximum paste forwards 16 chunks and stays driving; HTTP budgets/order proved by Vitest",
  );
  assert.equal(errors.length, 0, "No browser runtime exceptions");
} finally {
  await send("Page.close").catch(() => {});
  ws.close();
}
