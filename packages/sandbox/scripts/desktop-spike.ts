/** A dry-run-first, bounded throwaway desktop measurement. Never used by application boot. */

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ScopeDrainProofSchema } from "@nap/shared/ports/desktop-input-transport";
import type { DesktopAction } from "@nap/shared/ports/sandbox-desktop";
import { Sandbox, Template, waitForPort } from "e2b";
import { z } from "zod";
import { DesktopReplySchema, DesktopRequestSchema } from "../src/desktop-protocol.ts";
import { NAP_TEMPLATE } from "../src/template.ts";

const args = process.argv.slice(2);
const memoryMB = Number(args.find((arg) => arg.startsWith("--memory="))?.split("=")[1] ?? 1024);
if (![1024, 4096].includes(memoryMB)) throw new Error("Memory must be 1024 or 4096 MB.");
if (!args.includes("--real")) {
  console.log(
    JSON.stringify({
      real: false,
      cpuCount: 2,
      memoryMB,
      sandboxTimeoutMs: 600000,
      captures: 5,
      productionTemplateChanged: false,
    }),
  );
  process.exit(0);
}
if (!args.includes("--budget-usd=1"))
  throw new Error("Real runs require the approved --budget-usd=1 flag.");
if (!process.env.E2B_API_KEY) throw new Error("E2B_API_KEY is required.");
const output = resolve(
  args.find((arg) => arg.startsWith("--output="))?.slice(9) ??
    `.scratch/computer-use/spike-${memoryMB}`,
);
mkdirSync(output, { recursive: true });
const reportPath = `${output}/desktop.json`;
if (existsSync(reportPath))
  throw new Error(
    "This output already records an attempted run. Inspect it before spending again.",
  );
const name = `nap-computer-spike-${Date.now()}-${memoryMB}`;
const startedAt = Date.now();
const marker = `NAP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const report: Record<string, unknown> = {
  name,
  memoryMB,
  cpuCount: 2,
  startedAt: new Date(startedAt).toISOString(),
  marker,
  status: "starting",
};
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
save();
const driverAsset = args.find((arg) => arg.startsWith("--driver="))?.slice(9);
if (!driverAsset || !existsSync(driverAsset))
  throw new Error("Real input requires --driver=<reviewed scoped driver bundle>.");
const assets = mkdtempSync(resolve(tmpdir(), "nap-spike-assets-"));
cpSync(
  resolve(import.meta.dirname, "../desktop/start-desktop.sh"),
  resolve(assets, "start-desktop.sh"),
);
cpSync(driverAsset, resolve(assets, "driver.mjs"));
report.driverSha256 = createHash("sha256").update(readFileSync(driverAsset)).digest("hex");
const scopeId = crypto.randomUUID();
const install =
  "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y python3 libx11-6 libxtst6 xvfb x11-utils openbox xdotool ffmpeg x11vnc websockify novnc dbus-x11 fonts-liberation ca-certificates wget openssl util-linux && wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/nap-chrome.deb && apt-get install -y /tmp/nap-chrome.deb && rm /tmp/nap-chrome.deb && mkdir -p /etc/opt/chrome/policies/managed && chown user:user /etc/opt/chrome/policies/managed";
const template = Template({ fileContextPath: assets })
  .fromTemplate(NAP_TEMPLATE)
  .runCmd(install, { user: "root" })
  .makeDir("/usr/local/lib/nap-desktop", { user: "root" })
  .copy("driver.mjs", "/usr/local/lib/nap-desktop/driver.mjs", { user: "root" })
  .copy("start-desktop.sh", "/usr/local/bin/nap-desktop-start", { user: "root" })
  .runCmd("chmod 755 /usr/local/bin/nap-desktop-start", { user: "root" })
  .setStartCmd("cd /home/user/app && bun run dev", waitForPort(5173));
let built: Awaited<ReturnType<typeof Template.buildInBackground>> | undefined;
let sandbox: Sandbox | undefined;
async function scopedRequest(machine: Sandbox, action?: DesktopAction) {
  const request = DesktopRequestSchema.parse({
    id: crypto.randomUUID(),
    scopeId,
    sandboxId: machine.sandboxId,
    ...(action ? { op: "act", action } : { op: "close_scope" }),
  });
  const encoded = Buffer.from(JSON.stringify(request)).toString("base64");
  const result = await machine.commands.run(
    `timeout --signal=TERM --kill-after=2 55s node /usr/local/lib/nap-desktop/driver.mjs '${encoded}'`,
    { timeoutMs: 60_000 },
  );
  const reply = DesktopReplySchema.parse(JSON.parse(result.stdout));
  if (!reply.ok) throw new Error("Scoped desktop operation failed.");
  if (!action) {
    const proof = ScopeDrainProofSchema.parse(reply.value);
    if (proof.scopeId !== scopeId || proof.sandboxId !== machine.sandboxId)
      throw new Error("Drain proof identity mismatch.");
  }
}
async function inspect(machine: Sandbox) {
  const command = `node --input-type=module <<'NAP_INSPECT'
const pages = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = pages.find(p => p.type === 'page');
if (!page) throw Error('No browser page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map(); let id = 0;
const deadline = setTimeout(() => process.exit(2), 7000);
ws.onmessage = e => { const m = JSON.parse(String(e.data)); const p = pending.get(m.id); if (p) {pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);} };
await new Promise((resolve, reject) => {ws.onopen = resolve; ws.onerror = reject;});
const rpc = (method, params = {}) => new Promise((resolve, reject) => {const n = ++id; pending.set(n, {resolve, reject}); ws.send(JSON.stringify({id:n, method, params}));});
const {root} = await rpc('DOM.getDocument', {depth:0});
const {outerHTML} = await rpc('DOM.getOuterHTML', {nodeId: root.nodeId});
const {nodeId} = await rpc('DOM.querySelector', {nodeId:root.nodeId, selector:'button'});
let click = [0, 0]; let clicked = false;
if (nodeId) {
 const {model} = await rpc('DOM.getBoxModel', {nodeId});
 const layout = await rpc('Page.getLayoutMetrics');
 const button = await rpc('DOM.getOuterHTML', {nodeId});
 clicked = button.outerHTML.includes('>Clicked</button>');
 click = [Math.round((model.content[0]+model.content[4])/2), Math.round((model.content[1]+model.content[5])/2 + 768-layout.cssVisualViewport.clientHeight)];
}
console.log(JSON.stringify({markerVisible: outerHTML.includes(${JSON.stringify(marker)}), click, clicked, blocked:outerHTML.includes('ERR_BLOCKED_BY_ADMINISTRATOR') || outerHTML.includes('This page is blocked')}));
clearTimeout(deadline); ws.close();
NAP_INSPECT`;
  const result = await machine.commands.run(command, { timeoutMs: 10000 });
  return z
    .object({
      markerVisible: z.boolean(),
      clicked: z.boolean(),
      blocked: z.boolean(),
      click: z.tuple([z.int().min(0).max(1023), z.int().min(0).max(767)]),
    })
    .parse(JSON.parse(result.stdout));
}
try {
  built = await Template.buildInBackground(template, name, { cpuCount: 2, memoryMB });
  report.build = built;
  save();
  console.log(JSON.stringify({ phase: "build", ...built }));
  const deadline = Date.now() + 20 * 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    const status = await Template.getBuildStatus(built);
    if (status.status === "error")
      throw new Error(`Template build failed: ${status.reason?.message ?? "no reason"}`);
    if (status.status === "ready") {
      ready = true;
      break;
    }
    console.log(
      JSON.stringify({
        phase: "building",
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      }),
    );
    await new Promise((done) => setTimeout(done, 5000));
  }
  if (!ready) throw new Error("Template build exceeded the approved twenty-minute window.");
  report.buildMs = Date.now() - startedAt;
  const coldAt = Date.now();
  sandbox = await Sandbox.create(name, {
    timeoutMs: 600000,
    metadata: { purpose: "nap-computer-spike" },
  });
  report.sandboxId = sandbox.sandboxId;
  report.coldStartMs = Date.now() - coldAt;
  save();
  await sandbox.files.write(
    "/home/user/app/index.html",
    `<!doctype html><html><head><meta charset="utf-8"></head><body style="font:72px system-ui;background:white;color:black"><h1 style="font-size:64px">${marker}</h1><button style="font:32px system-ui" onclick="this.textContent='Clicked'">Click here</button></body></html>`,
  );
  const desktopAt = Date.now();
  await sandbox.commands.run("/usr/local/bin/nap-desktop-start 5173", { timeoutMs: 60000 });
  report.desktopStartMs = Date.now() - desktopAt;
  const before = await inspect(sandbox);
  if (!before.markerVisible || before.blocked)
    throw new Error("The project marker is not visible in Chrome. Do not run a model probe.");
  report.markerVerified = true;
  report.memory = (
    await sandbox.commands.run("free -m; ps -eo comm,rss --sort=-rss | head -12")
  ).stdout;
  report.effectiveMemory = (
    await sandbox.commands.run("cat /proc/meminfo | head -3; nproc")
  ).stdout;
  const shots: { durationMs: number; bytes: number }[] = [];
  for (let index = 0; index < 5; index++) {
    if (index === 4) {
      await scopedRequest(sandbox, { action: "left_click", coordinate: before.click });
      report.inputVerified = (await inspect(sandbox)).clicked;
      if (!report.inputVerified)
        throw new Error("The physical click did not change the app button.");
    }
    const at = Date.now();
    await sandbox.commands.run(
      `ffmpeg -nostdin -loglevel error -f x11grab -video_size 1024x768 -i :99 -frames:v 1 -q:v 3 -y /tmp/nap-spike-${index}.jpg`,
    );
    const bytes = await sandbox.files.read(`/tmp/nap-spike-${index}.jpg`, { format: "bytes" });
    writeFileSync(`${output}/frame-${index}.jpg`, bytes);
    if (index === 4) {
      writeFileSync(`${output}/after-input.jpg`, bytes);
      report.frameSha256 = createHash("sha256").update(bytes).digest("hex");
    }
    shots.push({ durationMs: Date.now() - at, bytes: bytes.length });
  }
  report.screenshots = shots;
  for (const action of [
    { action: "key", text: "ctrl+l" },
    { action: "type", text: "https://example.com" },
    { action: "key", text: "Return" },
  ] satisfies DesktopAction[])
    await scopedRequest(sandbox, action);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  report.externalNavigationBlocked = (await inspect(sandbox)).blocked;
  report.streamReachable =
    (
      await sandbox.commands.run(
        "curl -fsS -o /dev/null http://127.0.0.1:6080/vnc.html && echo ready",
      )
    ).stdout.trim() === "ready";
  report.status = "completed";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : "Unknown spike failure";
  process.exitCode = 1;
} finally {
  if (sandbox) {
    try {
      await scopedRequest(sandbox);
      report.scopeDrained = true;
    } catch {
      report.scopeDrained = false;
    }
    try {
      await sandbox.kill();
      report.sandboxKilled = true;
    } catch {
      report.sandboxKilled = false;
      process.exitCode = 1;
    }
  }
  if (built) {
    try {
      const deletion = await fetch(`https://api.e2b.dev/templates/${built.templateId}`, {
        method: "DELETE",
        headers: { "X-API-Key": process.env.E2B_API_KEY },
      });
      report.templateDeleted = deletion.ok || deletion.status === 404;
    } catch {
      report.templateDeleted = false;
    }
    if (!report.templateDeleted) process.exitCode = 1;
  }
  rmSync(assets, { recursive: true, force: true });
  report.totalMs = Date.now() - startedAt;
  save();
  console.log(
    JSON.stringify({
      phase: "finished",
      status: report.status,
      report: reportPath,
      sandboxKilled: report.sandboxKilled,
      templateDeleted: report.templateDeleted,
    }),
  );
}
