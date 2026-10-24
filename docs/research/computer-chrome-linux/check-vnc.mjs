import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { chromium } = await import(
  new URL("../../../apps/napbench/node_modules/playwright-core/index.mjs", import.meta.url)
);
const novnc = join(root, "apps/web/node_modules/@novnc/novnc");
assert.equal(JSON.parse(readFileSync(join(novnc, "package.json"))).version, "1.5.0");
const output = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "nap-vnc-evidence-")));
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), "nap-vnc-client-"));
const started = Date.now();
const proxies = new Set();
let ownedContainer;
let browser;
let runner;
let runnerExited = false;
let runnerCode;
let server;
const report = {
  checkerSha256: createHash("sha256")
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest("hex"),
  noVncVersion: "1.5.0",
  transport: "loopback ephemeral HTTP/WS to byte-preserving docker exec TCP pipe",
  cloud: false,
  wrongPasswordRejected: false,
  decodedFramebuffer: false,
  adversarialClientViewOnly: false,
  productionClientViewOnly: true,
};
function docker(args) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 4_000_000,
  });
  // A credentials reply stays private even when a command fails.
  if (result.status !== 0) throw new Error("Owned container command failed.");
  return result.stdout;
}
function driver(op, fields = {}) {
  assert(ownedContainer);
  const request = Buffer.from(JSON.stringify({ id: randomUUID(), op, ...fields })).toString(
    "base64",
  );
  const reply = JSON.parse(
    docker(["exec", ownedContainer, "node", "/usr/local/lib/nap-desktop/driver.mjs", request]),
  );
  assert.equal(reply.ok, true, "Production driver operation failed.");
  return reply.value;
}
const act = (action) => driver("act", { action });
const dom = () => act({ action: "read_dom" }).text;
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (runnerExited)
      throw new Error("The owned smoke runner exited before the VNC probe finished.");
    await delay(200);
  }
  throw new Error("Bounded VNC probe condition timed out.");
}
function waitForPage(page, condition, timeout = 15000) {
  return page.waitForFunction(condition, undefined, { timeout });
}
function saveReport() {
  writeFileSync(
    join(output, "vnc-report.json"),
    JSON.stringify({ ...report, elapsedMs: Date.now() - started }, null, 2),
  );
}
const abort = setTimeout(() => {
  if (ownedContainer) {
    try {
      docker(["rm", "-f", ownedContainer]);
    } catch {}
  }
  runner?.kill("SIGTERM");
  process.exitCode = 124;
}, 1170000);
try {
  const entry = join(temporary, "client.js");
  writeFileSync(
    entry,
    `import module from ${JSON.stringify(join(novnc, "lib/rfb.js"))};
const RFB=module.default??module;
window.connectRfb=(password,viewOnly)=>{
  window.state={connected:false,securityFailure:false,disconnected:false};
  const rfb=new RFB(document.querySelector('#screen'), 'ws://'+location.host+'/websockify', {credentials:{password},shared:true});
  rfb.viewOnly=viewOnly; rfb.scaleViewport=false; rfb.resizeSession=false;
  rfb.addEventListener('connect',()=>{window.state.connected=true;});
  rfb.addEventListener('securityfailure',()=>{window.state.securityFailure=true;});
  rfb.addEventListener('disconnect',()=>{window.state.disconnected=true;});
  window.rfb=rfb;
};
window.frame=()=>{
  const canvas=document.querySelector('canvas'); if(!canvas)return null;
  const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
  const colors=new Set();for(let i=0;i<data.length;i+=4*127)colors.add(data[i]+','+data[i+1]+','+data[i+2]);
  // The pinned fixture's green result text occupies this region; exclude input focus and cursor.
  let resultGreenPixels=0;
  if(canvas.width>=524&&canvas.height>=328)for(let y=292;y<328;y++)for(let x=24;x<524;x++){
    const i=(y*canvas.width+x)*4;const r=data[i],g=data[i+1],b=data[i+2];
    if(g>100&&g-r>30&&g-b>10)resultGreenPixels++;
  }
  return {width:canvas.width,height:canvas.height,colors:colors.size,resultGreenPixels,png:canvas.toDataURL('image/png')};
};
window.attackRfb=()=>{
  const rfb=window.rfb; if(rfb.viewOnly)throw new Error('Adversarial client must permit input.');
  const ws=rfb._sock._websocket; const send=ws.send.bind(ws); const counts={key:0,pointer:0};
  ws.send=data=>{const bytes=new Uint8Array(data.buffer??data,data.byteOffset??0,data.byteLength);if(bytes.length===8&&bytes[0]===4)counts.key++;if(bytes.length===6&&bytes[0]===5)counts.pointer++;send(data);};
  RFB.messages.keyEvent(rfb._sock,120,1);RFB.messages.keyEvent(rfb._sock,120,0);
  RFB.messages.pointerEvent(rfb._sock,370,265,1);RFB.messages.pointerEvent(rfb._sock,370,265,0);
  return counts;
};`,
  );
  execFileSync(
    "bun",
    [
      "build",
      entry,
      "--target=browser",
      "--format=esm",
      `--outfile=${join(temporary, "client-bundle.js")}`,
    ],
    { cwd: root, timeout: 30000, stdio: "pipe" },
  );
  report.clientBundleSha256 = createHash("sha256")
    .update(readFileSync(join(temporary, "client-bundle.js")))
    .digest("hex");
  const args = [join(root, "packages/sandbox/scripts/desktop-chrome-smoke/run.ts"), output];
  assert([undefined, "writable", "frozen"].includes(process.argv[3]));
  report.frozenObservationControl = process.argv[3] === "frozen";
  if (process.argv[3] === "writable") args.push("vnc-input");
  runner = spawn("bun", args, {
    cwd: root,
    env: { ...process.env, NAP_CHROME_VNC_PROBE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = createWriteStream(join(temporary, "runner.log"));
  runner.stdout.pipe(log, { end: false });
  runner.stderr.pipe(log, { end: false });
  runner.on("exit", (code) => {
    runnerCode = code;
    runnerExited = true;
    log.end();
  });
  await until(() => existsSync(join(output, "container-name.txt")), 950000);
  ownedContainer = readFileSync(join(output, "container-name.txt"), "utf8").trim();
  assert.match(ownedContainer, /^nap-chrome-smoke-[0-9a-f-]+$/);
  await until(
    () =>
      spawnSync("docker", ["exec", ownedContainer, "test", "-f", "/evidence/vnc-ready"], {
        timeout: 3000,
        stdio: "ignore",
      }).status === 0,
    150000,
  );
  assert(
    docker([
      "container",
      "ls",
      "-a",
      "--filter",
      `name=^/${ownedContainer}$`,
      "--format",
      "{{.ID}}",
    ]).trim(),
  );
  assert(
    docker([
      "image",
      "ls",
      "--filter",
      `reference=${ownedContainer}:local`,
      "--format",
      "{{.ID}}",
    ]).trim(),
  );
  report.ownedResourcesVisibleToVerificationFilters = true;
  server = createServer((request, response) => {
    if (request.url === "/client.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(readFileSync(join(temporary, "client-bundle.js")));
    } else {
      response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      response.end(
        '<!doctype html><html lang="en"><title>Actual Docker VNC probe</title><body style="margin:0"><div id="screen" style="width:1024px;height:768px"></div><script type="module" src="/client.js"></script></body></html>',
      );
    }
  });
  server.on("upgrade", (request, socket, head) => {
    const proxy = spawn(
      "docker",
      [
        "exec",
        "-i",
        ownedContainer,
        "node",
        "-e",
        "const s=require('net').connect(6080,'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout);process.stdin.on('end',()=>s.end());s.on('error',()=>process.exit(1));",
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    proxies.add(proxy);
    const headers = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2)
      headers.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
    proxy.stdin.write(
      `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`,
    );
    if (head.length) proxy.stdin.write(head);
    socket.pipe(proxy.stdin);
    proxy.stdout.pipe(socket);
    socket.on("error", () => proxy.kill());
    proxy.stdin.on("error", () => socket.destroy());
    socket.on("close", () => proxy.kill());
    proxy.on("exit", () => {
      proxies.delete(proxy);
      socket.destroy();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  assert(![3037, 3038, 3039].includes(address.port));
  report.loopbackPort = address.port;
  browser = await chromium.launchPersistentContext(join(temporary, "chrome-profile"), {
    executablePath:
      process.env.NAP_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    viewport: { width: 1024, height: 768 },
  });
  report.localChromeVersion = browser.browser()?.version();
  const url = `http://127.0.0.1:${address.port}/`;
  async function connect(password, viewOnly) {
    const page = await browser.newPage();
    await page.goto(url);
    await waitForPage(page, () => typeof window.connectRfb === "function");
    await page.evaluate(({ password, viewOnly }) => window.connectRfb(password, viewOnly), {
      password,
      viewOnly,
    });
    return page;
  }
  const wrong = await connect("intentionally-wrong-fixture-password", true);
  await waitForPage(wrong, () => window.state.securityFailure, 12000);
  assert.equal(await wrong.evaluate(() => window.state.connected), false);
  report.wrongPasswordRejected = true;
  await wrong.close();
  // Never log, return in a report, or persist the generated VNC password.
  const password = driver("credentials").password;
  assert.equal(typeof password, "string");
  const view = await connect(password, true);
  await waitForPage(view, () => window.state.connected && window.frame()?.colors > 8);
  report.productionClientViewOnly = await view.evaluate(() => window.rfb.viewOnly);
  assert.equal(report.productionClientViewOnly, true);
  const decoded = await view.evaluate(() => window.frame());
  assert.equal(decoded.width, 1024);
  assert.equal(decoded.height, 768);
  assert(decoded.colors > 8);
  const image = Buffer.from(decoded.png.split(",")[1], "base64");
  writeFileSync(join(output, "vnc-decoded.png"), image);
  report.decodedFramebuffer = true;
  report.decodedFrame = {
    width: decoded.width,
    height: decoded.height,
    sampledColors: decoded.colors,
    bytes: image.length,
    sha256: createHash("sha256").update(image).digest("hex"),
  };
  await view.close();
  act({ action: "key", text: "CTRL+l" });
  act({ action: "type", text: "http://127.0.0.1:5174/" });
  act({ action: "key", text: "Return" });
  await until(() => dom().includes("Waiting for input"));
  act({ action: "left_click", coordinate: [170, 265] });
  act({ action: "type", text: "BASE" });
  const attack = await connect(password, false);
  await waitForPage(attack, () => window.state.connected && window.frame()?.colors > 8);
  report.adversarialClientViewOnly = await attack.evaluate(() => window.rfb.viewOnly);
  assert.equal(report.adversarialClientViewOnly, false);
  report.adversarialMessages = await attack.evaluate(() => window.attackRfb());
  assert.equal(report.adversarialMessages.key, 2);
  assert.equal(report.adversarialMessages.pointer, 2);
  await delay(700);
  const afterAttack = dom();
  writeFileSync(join(output, "vnc-adversarial-dom.txt"), afterAttack);
  report.adversarialObservedResult = afterAttack.match(/<p id="result">([^<]*)/)?.[1];
  const attackFrame = await attack.evaluate(() => window.frame());
  writeFileSync(
    join(output, "vnc-adversarial.png"),
    Buffer.from(attackFrame.png.split(",")[1], "base64"),
  );
  report.serverDeniedPointer = afterAttack.includes("Waiting for input");
  assert.equal(
    report.serverDeniedPointer,
    true,
    "The actual server accepted adversarial RFB pointer input.",
  );
  act({ action: "left_click", coordinate: [370, 265] });
  const afterPhysicalClick = dom();
  report.serverDeniedKey = afterPhysicalClick.includes("Applied: BASE</p>");
  assert.equal(
    report.serverDeniedKey,
    true,
    "The actual server accepted adversarial RFB key input.",
  );
  // Baseline the same decoder immediately before physical marker input.
  let beforePhysical;
  await until(async () => {
    beforePhysical = await attack.evaluate(() => window.frame());
    return beforePhysical?.resultGreenPixels > 100;
  }, 5000);
  writeFileSync(
    join(output, "vnc-before-physical.png"),
    Buffer.from(beforePhysical.png.split(",")[1], "base64"),
  );
  report.resultRegion = {
    x: 24,
    y: 292,
    width: 500,
    height: 36,
    minimumGrowth: 100,
    beforeGreenPixels: beforePhysical.resultGreenPixels,
  };
  act({ action: "left_click", coordinate: [170, 265] });
  act({ action: "key", text: "CTRL+a" });
  act({ action: "type", text: "PHYSICAL-AFTER-VNC" });
  act({ action: "left_click", coordinate: [370, 265] });
  await until(() => dom().includes("Applied: PHYSICAL-AFTER-VNC"));
  report.productionPhysicalInputWorks = true;
  let after;
  await until(async () => {
    after = report.frozenObservationControl
      ? beforePhysical
      : await attack.evaluate(() => window.frame());
    report.resultRegion.afterGreenPixels = after.resultGreenPixels;
    return after.resultGreenPixels > beforePhysical.resultGreenPixels + 100;
  }, 5000);
  report.sameClientResultRegionUpdated = true;
  writeFileSync(
    join(output, "vnc-after-physical.png"),
    Buffer.from(after.png.split(",")[1], "base64"),
  );
  await attack.close();
  docker(["exec", ownedContainer, "touch", "/evidence/vnc-finished"]);
  await until(() => runnerExited, 15000).catch((error) => {
    if (!runnerExited) throw error;
  });
  assert.equal(runnerCode, 0);
  report.ok = true;
  saveReport();
} catch (error) {
  report.ok = false;
  report.failure = String(error);
  saveReport();
  throw error;
} finally {
  clearTimeout(abort);
  const cleanupErrors = [];
  try {
    await browser?.close();
  } catch (error) {
    cleanupErrors.push(`Temporary Chrome cleanup failed: ${String(error)}`);
  }
  for (const proxy of proxies) {
    try {
      proxy.kill();
    } catch (error) {
      cleanupErrors.push(`Owned bridge cleanup failed: ${String(error)}`);
    }
  }
  try {
    server?.closeAllConnections();
    server?.close();
  } catch (error) {
    cleanupErrors.push(`Loopback listener cleanup failed: ${String(error)}`);
  }
  if (!runnerExited && ownedContainer) {
    try {
      docker(["exec", ownedContainer, "touch", "/evidence/vnc-finished"]);
    } catch {}
    const deadline = Date.now() + 15000;
    while (!runnerExited && Date.now() < deadline) await delay(100);
    if (!runnerExited) {
      try {
        docker(["rm", "-f", ownedContainer]);
      } catch {}
      runner?.kill("SIGTERM");
      const stopDeadline = Date.now() + 10000;
      while (!runnerExited && Date.now() < stopDeadline) await delay(100);
    }
  }
  if (!runnerExited && runner) {
    runner.kill("SIGKILL");
    cleanupErrors.push("Owned runner did not exit after bounded cleanup.");
  }
  if (ownedContainer) {
    for (const args of [
      ["container", "ls", "-a", "--filter", `name=^/${ownedContainer}$`, "--format", "{{.ID}}"],
      ["image", "ls", "--filter", `reference=${ownedContainer}:local`, "--format", "{{.ID}}"],
    ]) {
      try {
        if (docker(args).trim())
          cleanupErrors.push(`Owned Docker resource still present: ${ownedContainer}.`);
      } catch (error) {
        cleanupErrors.push(
          `Could not verify owned resource absence for ${ownedContainer}: ${String(error)}`,
        );
      }
    }
  }
  try {
    if (existsSync(join(temporary, "runner.log")))
      writeFileSync(join(output, "vnc-runner.log"), readFileSync(join(temporary, "runner.log")));
  } catch (error) {
    cleanupErrors.push(`Could not retain runner cleanup output: ${String(error)}`);
  }
  try {
    rmSync(temporary, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(`Temporary profile removal failed: ${String(error)}`);
  }
  report.httpListenerClosed = !server?.listening;
  report.temporaryProfileRemoved = !existsSync(temporary);
  if (!report.httpListenerClosed || !report.temporaryProfileRemoved)
    cleanupErrors.push("An owned listener or temporary profile remains.");
  report.cleanupVerified = cleanupErrors.length === 0;
  if (cleanupErrors.length) {
    report.ok = false;
    report.cleanupErrors = cleanupErrors;
    process.exitCode = 1;
    console.error(cleanupErrors.join("\n"));
  }
  try {
    saveReport();
  } catch (error) {
    report.ok = false;
    process.exitCode = 1;
    console.error(`Could not retain final cleanup report: ${String(error)}`);
  }
}
if (report.ok && report.cleanupVerified)
  console.log(
    "PASS: actual noVNC 1.5 password rejection/authentication, decoded framebuffer, server view-only key/pointer refusal, subsequent production physical input, and verified owned cleanup.",
  );
