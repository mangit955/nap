// Local fixture only. Never connects to a logged-in or passive reference browser.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const endpoint = process.argv[2] ?? "http://127.0.0.1:9346";
const pageUrl = process.argv[3] ?? "http://127.0.0.1:4326";
assert.equal(new URL(endpoint).hostname, "127.0.0.1");
assert.equal(new URL(endpoint).port, "9346", "Use the dedicated take-control Chrome port");
assert.equal(new URL(pageUrl).hostname, "127.0.0.1", "Only drive the local fixture");
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
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${expression}`);
}
const output = fileURLToPath(new URL(".", import.meta.url));
async function shot(name) {
  const { data } = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(`${output}${name}.png`, Buffer.from(data, "base64"));
}
const textbox = 'textarea[aria-label="Type on the remote computer"]';
const counts = 'JSON.parse(document.querySelector("output").dataset.counts)';
async function checked(label) {
  await evaluate(
    `Array.from(document.querySelectorAll('label')).find(e => e.textContent.trim() === ${JSON.stringify(label)}).querySelector('input').click()`,
  );
}
async function pointer(x, y, clickCount = 1, button = "left") {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });
}
async function key(key, code, modifiers = 0) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
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
  assert.equal(
    await evaluate(
      'document.querySelectorAll(\'[role="application"][aria-label="Remote computer"]\').length',
    ),
    1,
  );
  assert.equal(
    await evaluate('document.body.textContent.includes("Click anywhere to drive the computer")'),
    true,
  );
  await shot("nap-take-control-live");
  const rect = await evaluate(
    `(() => { const r = document.querySelector(${JSON.stringify(textbox)}).getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()`,
  );
  const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  await pointer(center.x, center.y);
  await until('document.querySelector(".screen").dataset.driving === "true"');
  assert.equal(
    await evaluate(`(${counts}).left_click ?? 0`),
    0,
    "Activation must not input remotely",
  );
  await pointer(center.x, center.y);
  await until(`(${counts}).left_click === 1`);
  assert.equal(
    await evaluate('document.querySelector("output").textContent.includes("left_click@512,384")'),
    true,
  );
  await pointer(center.x, center.y, 1);
  await pointer(center.x, center.y, 2);
  await until(`(${counts}).double_click === 1`);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(
    await evaluate(`(${counts}).left_click`),
    1,
    "Double-click must not dispatch singles",
  );
  await pointer(center.x, center.y, 1, "right");
  await until(`(${counts}).right_click === 1`);
  await pointer(center.x, center.y, 1, "middle");
  await until(`(${counts}).middle_click === 1`);
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: center.x,
    y: center.y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: center.x + 50,
    y: center.y + 40,
    buttons: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: center.x + 50,
    y: center.y + 40,
    button: "left",
    clickCount: 1,
  });
  await until(`(${counts}).left_click_drag === 1`);
  await send("Input.insertText", { text: "local fixture input" });
  await until(`(${counts}).type === 1`);
  await send("Input.imeSetComposition", { text: "日本", selectionStart: 2, selectionEnd: 2 });
  await send("Input.insertText", { text: "日本" });
  await until(`(${counts}).type === 2`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await evaluate(`(${counts}).type`), 2, "IME commits exactly once");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(textbox)}).value`), "");
  await evaluate('document.body.style.minHeight = "200vh"');
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: center.x,
    y: center.y,
    deltaY: 300,
    deltaX: 0,
  });
  await until(`(${counts}).scroll === 1`);
  assert.equal(await evaluate("scrollY"), 0, "Remote wheel must not scroll the local document");
  await evaluate('document.body.style.minHeight = ""');
  await key("a", "KeyA", 2);
  await until(`(${counts}).key === 1`);
  await key("Escape", "Escape");
  await until(`(${counts}).key === 2`);
  await shot("nap-take-control-driving");
  await key("Escape", "Escape", 8);
  await until('!document.querySelector(".screen").dataset.driving');
  await evaluate(
    'Array.from(document.querySelectorAll("button")).find(e => e.textContent === "Take control of Nap’s computer").click()',
  );
  await until('document.querySelector(".screen").dataset.driving === "true"');
  await checked("Another session leased");
  await until('!document.querySelector(".screen").dataset.driving');
  await shot("nap-take-control-project-busy");
  assert.equal(await evaluate('document.querySelector("button").disabled'), true);
  await checked("Another session leased");
  await checked("Current turn busy");
  assert.equal(await evaluate('document.querySelector("button").disabled'), true);
  await checked("Current turn busy");
  await checked("History");
  await until('document.querySelector("[role=status]").textContent.includes("live desktop")');
  await shot("nap-take-control-history");
  await checked("History");
  await checked("Disconnected");
  await until('document.querySelector("[role=status]").textContent.includes("Connect")');
  await shot("nap-take-control-disconnected");
  await checked("Disconnected");
  await until('!document.querySelector("button").disabled');
  await evaluate('document.querySelector("button").click()');
  await until('document.querySelector(".screen").dataset.driving === "true"');
  await checked("Fail next input");
  // Checkbox interaction changes focus; explicitly refocus the input for remote keyboard input.
  await evaluate(`document.querySelector(${JSON.stringify(textbox)}).focus()`);
  await key("Escape", "Escape");
  await until('document.querySelector("[role=alert]")?.textContent.includes("partly applied")');
  await shot("nap-take-control-input-failed");
  await checked("Fail next input");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-reduced-transparency", value: "reduce" },
    ],
  });
  await until('!document.querySelector("button").disabled');
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await evaluate('document.querySelector("button").click()');
  await until('document.querySelector(".screen").dataset.driving === "true"');
  const phone = await evaluate(
    `(() => { const r = document.querySelector(${JSON.stringify(textbox)}).getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()`,
  );
  const clicksBefore = await evaluate(`(${counts}).left_click`);
  await pointer(phone.x + phone.w / 2, phone.y + 5);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(
    await evaluate(`(${counts}).left_click`),
    clicksBefore,
    "Phone letterbox must ignore pointer input",
  );
  await shot("nap-take-control-phone");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: actual hook and input component, trusted pointer/double/right/middle/whole-drag, text/chord/Escape/exit, project busy revocation, history/disconnect, ambiguous failure, phone letterbox and seven captures. Local fake HTTP only.",
  );
} finally {
  ws.close();
  await fetch(`${endpoint}/json/close/${target.id}`);
}
