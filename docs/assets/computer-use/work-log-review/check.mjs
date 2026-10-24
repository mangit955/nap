// Run against a dedicated headless Chrome, never the logged-in Devin browser.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const endpoint = process.argv[2] ?? "http://127.0.0.1:9337";
const pageUrl = process.argv[3] ?? "http://localhost:4320/computer-review";
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
let jpeg = "";

ws.onmessage = ({ data }) => {
  const message = JSON.parse(String(data));
  if (message.method === "Fetch.requestPaused") {
    const request = message.params;
    const failed = request.request.url.includes("/999");
    void send("Fetch.fulfillRequest", {
      requestId: request.requestId,
      responseCode: failed ? 404 : 200,
      responseHeaders: [
        { name: "Content-Type", value: "image/jpeg" },
        { name: "Access-Control-Allow-Origin", value: "http://localhost:4320" },
        { name: "Access-Control-Allow-Credentials", value: "true" },
      ],
      body: failed ? "" : jpeg,
    }).catch((error) => errors.push(error.message));
  }
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
  await send("Page.navigate", { url: "http://127.0.0.1:4319/docs/computer-use-mockup.html" });
  await until("document.querySelector('.frame') !== null");
  await evaluate(
    "(() => { const frame = document.querySelector('.frame'); Object.assign(frame.style, {position:'fixed',left:'0',top:'0',width:'1024px',height:'768px',maxWidth:'none',border:'0',zIndex:'999'});frame.style.setProperty('--screen-scale','1'); })()",
  );
  const raster = await send("Page.captureScreenshot", {
    format: "jpeg",
    quality: 85,
    clip: { x: 0, y: 0, width: 1024, height: 768, scale: 1 },
  });
  jpeg = raster.data;
  await writeFile(`${output}fixture-desktop.jpg`, Buffer.from(jpeg, "base64"));
  await send("Fetch.enable", {
    patterns: [{ urlPattern: "http://localhost:3001/sessions/*/computer/screenshots/*" }],
  });
  await send("Page.navigate", { url: pageUrl });
  await until(
    "document.querySelector('[aria-label=\"Remote computer\"]') !== null && !document.body.innerText.includes('Connecting to')",
  );
  await evaluate(
    `(() => {const s=document.querySelector('[aria-label="Review state"]');s.value='work log';s.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await until(`document.querySelector('[aria-label="Used computer - 2 actions"]') !== null`);
  await evaluate(`document.querySelector('[aria-label="Used computer - 2 actions"]').click()`);
  await until(`document.querySelector('[aria-label="Session timeline"]').value === '3'`);
  assert.equal(await evaluate(`document.body.innerText.includes('Typed text')`), true);
  assert.equal(await evaluate(`document.body.innerText.includes('fixture-secret')`), false);
  await shot("nap-work-log-expanded");
  await evaluate(
    `[...document.querySelectorAll("button")].find(b => b.textContent === "Go to live desktop").click()`,
  );
  await evaluate(`document.querySelector('[aria-label="Open computer screenshot"]').click()`);
  await until(`document.querySelector('[aria-label="Session timeline"]').value === '3'`);
  assert.equal(
    await evaluate(`document.querySelector('[alt="Computer screenshot"]').crossOrigin`),
    "use-credentials",
  );
  await shot("nap-screenshot-seek");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await shot("nap-work-log-phone");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: actual transcript action labels, private text hidden, row/card seek to frame 3, credentialed images, 390px layout. No API, model or sandbox.",
  );
} finally {
  await fetch(`${endpoint}/json/close/${target.id}`);
  ws.close();
}
