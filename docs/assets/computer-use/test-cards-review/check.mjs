// Run against a dedicated headless Chrome, never the logged-in Devin browser.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const endpoint = process.argv[2] ?? "http://127.0.0.1:9337";
const pageUrl = process.argv[3] ?? "http://localhost:4320/app-test-review";
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
async function until(expression) {
  for (let i = 0; i < 150; i++) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${expression}`);
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
    `document.querySelector('[aria-label="Review test state"]') !== null && [...document.querySelectorAll('button')].some(b => b.textContent === 'Test the app' && !b.disabled)`,
  );
  assert.equal(
    await evaluate(`(() => {
    const button=[...document.querySelectorAll('button')].find(b => b.textContent === 'Test the app');
    const style=getComputedStyle(button);
    const luminance = color => color.match(/[\\d.]+/g).slice(0,3).map(Number).map(v => {v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
    const a=luminance(style.color), b=luminance(style.backgroundColor);
    return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05) >= 4.5;
  })()`),
    true,
    "Primary labels must have 4.5:1 contrast",
  );
  await shot("nap-test-approval");
  await evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent === 'Test the app').click()`,
  );
  await until(
    `document.querySelector('[aria-label="Review requests"]').textContent.includes('/tests')`,
  );
  assert.equal(await evaluate(`document.querySelector('[aria-label="Message"]').disabled`), true);
  await shot("nap-test-running");
  for (const mode of ["passed", "failed", "untested", "interrupted"]) {
    await evaluate(
      `(() => {const s=document.querySelector('[aria-label="Review test state"]');s.value='${mode}';s.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await until(
      `document.querySelector('[aria-label="App test results"]') !== null && [...document.querySelectorAll('button')].some(b => b.textContent === 'Test the app' && !b.disabled)`,
    );
    assert.equal(
      await evaluate(
        `document.querySelector('[aria-label="Review requests"]').textContent.includes('/turns')`,
      ),
      false,
    );
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll('button')].find(b => b.textContent === 'Watch recording').disabled`,
      ),
      true,
    );
    await shot(`nap-test-${mode}`);
  }
  await evaluate(
    `(() => {const s=document.querySelector('[aria-label="Review test state"]');s.value='failed';s.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await until(
    `[...document.querySelectorAll('button')].some(b => b.textContent === 'Fix it' && !b.disabled)`,
  );
  await evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent === 'Fix it').click()`,
  );
  await until(
    `document.querySelector('[aria-label="Review requests"]').textContent.includes('/turns')`,
  );
  await shot("nap-test-fix-requested");
  await send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-reduced-transparency", value: "reduce" },
    ],
  });
  assert.equal(
    await evaluate(`getComputedStyle(document.querySelector('.app-test-card')).backdropFilter`),
    "none",
  );
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await shot("nap-test-phone");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real LiveChatPane, app-test receipt, no automatic repair, explicit normal-turn repair, eight captures, reduced transparency and 390px. In-memory server only; no model or sandbox.",
  );
} finally {
  await fetch(`${endpoint}/json/close/${target.id}`);
  ws.close();
}
