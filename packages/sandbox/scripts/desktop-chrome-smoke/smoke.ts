import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { DesktopAction } from "@nap/shared/ports/sandbox-desktop";
import { z } from "zod";
import { openCdpSocket } from "../../src/desktop-cdp-bridge.ts";
import {
  DESKTOP_CDP_SOCKET,
  DESKTOP_DRIVER,
  DESKTOP_STATE,
  DesktopImageSchema,
  DesktopObservationSchema,
  DesktopReplySchema,
  DesktopRequestSchema,
  DesktopSizeSchema,
  RecordingTimestampSchema,
  RecordingVideoSchema,
} from "../../src/desktop-protocol.ts";

const output = "/evidence";
const started = Date.now();
const steps: { name: string; elapsedMs: number }[] = [];
const timings: { op: string; ms: number }[] = [];
const fixture = spawn("node", ["/smoke/fixture.mjs"], { stdio: "inherit" });
const recordingId = randomUUID();
const inputScope = randomUUID();
let lastDom = "";
function save(name: string, value: unknown) {
  writeFileSync(`${output}/${name}.json`, JSON.stringify(value, null, 2));
}
function step(name: string) {
  steps.push({ name, elapsedMs: Date.now() - started });
  save("steps", steps);
  console.log(name);
}
function invoke(op: string, fields: Record<string, unknown> = {}) {
  const request = DesktopRequestSchema.parse({
    id: randomUUID(),
    op,
    ...(op === "act" || op === "close_scope"
      ? { scopeId: inputScope, sandboxId: "standalone-smoke" }
      : {}),
    ...fields,
  });
  const start = Date.now();
  const result = spawnSync(
    "node",
    [DESKTOP_DRIVER, Buffer.from(JSON.stringify(request)).toString("base64")],
    {
      encoding: "utf8",
      timeout: 55000,
      killSignal: "SIGKILL",
      maxBuffer: 30_000_000,
    },
  );
  timings.push({ op, ms: Date.now() - start });
  assert.equal(result.error, undefined, `Driver ${op}: ${result.error}`);
  const reply = DesktopReplySchema.parse(JSON.parse(result.stdout));
  assert.equal(result.status, reply.ok ? 0 : 1);
  return reply;
}
function driver(op: string, fields: Record<string, unknown> = {}) {
  const reply = invoke(op, fields);
  assert.equal(reply.ok, true, `Driver ${op}: ${JSON.stringify(reply)}`);
  if (!reply.ok) throw new Error("Driver refused operation.");
  return reply.value;
}
const act = (action: DesktopAction) =>
  driver(
    ["read_dom", "console", "cursor_position", "wait", "zoom"].includes(action.action)
      ? "observe"
      : "act",
    { action },
  );
function dom() {
  const observation = DesktopObservationSchema.parse(act({ action: "read_dom" }));
  assert.equal(observation.kind, "text");
  if (observation.kind !== "text") throw new Error("Missing DOM observation.");
  lastDom = observation.text;
  return lastDom;
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(150);
  }
  throw new Error("Smoke condition did not become true in 12 seconds.");
}
async function navigate(url: string) {
  act({ action: "key", text: "CTRL+l" });
  act({ action: "type", text: url });
  act({ action: "key", text: "Return" });
  await delay(300);
}
async function screenshot(name: string) {
  const image = DesktopImageSchema.parse(driver("screenshot"));
  const bytes = Buffer.from(image.data, "base64");
  assert.equal(bytes.readUInt16BE(0), 0xffd8);
  assert.equal(image.width, 1024);
  assert.equal(image.height, 768);
  writeFileSync(`${output}/${name}.jpg`, bytes);
  const probe = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_name,width,height",
      "-of",
      "json",
      `${output}/${name}.jpg`,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  const metadata = z
    .object({
      streams: z
        .array(z.object({ codec_name: z.string(), width: z.number(), height: z.number() }))
        .length(1),
    })
    .parse(JSON.parse(probe));
  assert.equal(metadata.streams[0]?.codec_name, "mjpeg");
  assert.equal(metadata.streams[0]?.width, 1024);
  assert.equal(metadata.streams[0]?.height, 768);
  return { width: image.width, height: image.height, bytes: bytes.length };
}
function identity() {
  const record = readFileSync(`${DESKTOP_STATE}/chrome-owner`, "utf8").trim();
  const match = /^(\d+) (\d+) (\d+)$/.exec(record);
  assert.ok(match);
  const pid = Number(match[1]);
  const ticks = match[2];
  const port = Number(match[3]);
  assert.ok(pid > 1 && ticks);
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
  assert.notEqual(fields[0], "Z");
  assert.equal(fields[19], ticks);
  // The recorded process is the debugger bridge, which runs Chrome as its child.
  const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  assert.ok(command.includes(`--user-data-dir=${DESKTOP_STATE}/chrome`));
  assert.ok(command.includes("--cdp-bridge"));
  assert.ok(command.includes(DESKTOP_CDP_SOCKET));
  assert.ok(command.includes("--remote-debugging-pipe"));
  assert.ok(!command.some((arg) => arg.startsWith("--remote-debugging-port")));
  const debuggerPorts = ["/proc/net/tcp", "/proc/net/tcp6"].flatMap((path) =>
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((row) => row[1]?.endsWith(":2406") && row[3] === "0A"),
  );
  assert.deepEqual(debuggerPorts, [], "Nothing may listen on the old debugging port.");
  assert.equal(statSync(DESKTOP_CDP_SOCKET).mode & 0o777, 0o600);
  const sockets = readFileSync("/proc/net/unix", "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((row) => row[3] === "00010000" && row[7] === DESKTOP_CDP_SOCKET)
    .map((row) => row[6]);
  assert.ok(sockets.length > 0);
  const descriptors = readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
    try {
      return [readlinkSync(`/proc/${pid}/fd/${fd}`)];
    } catch {
      return [];
    }
  });
  for (const inode of sockets)
    assert.ok(
      descriptors.includes(`socket:[${inode}]`),
      "The recorded bridge must own the debugger socket.",
    );
  return { pid, ticks, port, record };
}

// One request through the debugger bridge, on a page session when one is given.
async function cdp(method: string, params: object = {}, sessionId?: string): Promise<unknown> {
  const socket = openCdpSocket(DESKTOP_CDP_SOCKET, 16_000_000);
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`${method} timed out.`)), 5000);
      const settle = (done: () => void) => {
        clearTimeout(deadline);
        done();
      };
      socket.addEventListener("error", () => settle(() => reject(new Error("Socket failed."))));
      socket.addEventListener("open", () =>
        socket.send(JSON.stringify({ id: 1, method, params, ...(sessionId ? { sessionId } : {}) })),
      );
      socket.addEventListener("message", (event) => {
        const reply = z
          .object({ id: z.number(), result: z.unknown().optional(), error: z.unknown().optional() })
          .safeParse(JSON.parse(String((event as MessageEvent).data)));
        if (!reply.success || reply.data.id !== 1) return;
        const { result, error } = reply.data;
        settle(() => (error ? reject(new Error(JSON.stringify(error))) : resolve(result)));
      });
    });
  } finally {
    socket.close();
  }
}
const targets = async () =>
  z
    .object({
      targetInfos: z.array(z.object({ targetId: z.string(), type: z.string(), url: z.string() })),
    })
    .parse(await cdp("Target.getTargets")).targetInfos;

// Read-only geometry and failure diagnostics. Assertions use production observations.
// Each call is one connection, so the bridge detaches its session as the connection closes.
async function observeActualPage(expression: string): Promise<unknown> {
  const page = (await targets()).find(
    (target) => target.type === "page" && /^https?:\/\//.test(target.url),
  );
  assert.ok(page);
  const socket = openCdpSocket(DESKTOP_CDP_SOCKET, 16_000_000);
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("Geometry observation timed out.")), 5000);
      let sessionId: string | undefined;
      socket.addEventListener("error", () => {
        clearTimeout(deadline);
        reject(new Error("Geometry socket failed."));
      });
      socket.addEventListener("open", () =>
        socket.send(
          JSON.stringify({
            id: 1,
            method: "Target.attachToTarget",
            params: { targetId: page.targetId, flatten: true },
          }),
        ),
      );
      socket.addEventListener("message", (event) => {
        try {
          const message = z
            .object({ id: z.number().optional(), result: z.unknown().optional() })
            .parse(JSON.parse(String((event as MessageEvent).data)));
          if (message.id === 1) {
            sessionId = z.object({ sessionId: z.string() }).parse(message.result).sessionId;
            socket.send(
              JSON.stringify({
                id: 2,
                sessionId,
                method: "Runtime.evaluate",
                params: { expression, returnByValue: true },
              }),
            );
          } else if (message.id === 2) {
            clearTimeout(deadline);
            resolve(
              z.object({ result: z.object({ value: z.unknown() }) }).parse(message.result).result
                .value,
            );
          }
        } catch (error) {
          clearTimeout(deadline);
          reject(error);
        }
      });
    });
  } finally {
    socket.close();
  }
}
async function point(selector: string): Promise<[number, number]> {
  return z
    .tuple([z.number(), z.number()])
    .parse(
      await observeActualPage(
        `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return [Math.round(screenX+(outerWidth-innerWidth)/2+r.x+r.width/2),Math.round(screenY+outerHeight-innerHeight+r.y+r.height/2)]})()`,
      ),
    );
}

try {
  await until(async () => {
    try {
      return (await fetch("http://127.0.0.1:5173")).ok && (await fetch("http://127.0.0.1:5174")).ok;
    } catch {
      return false;
    }
  });
  step("Two container-local fixture ports ready");
  DesktopSizeSchema.parse(driver("start", { port: 5173 }));
  await until(() => dom().includes("Origin http://localhost:5173"));
  const initial = identity();
  assert.equal(initial.port, 5173);
  if (process.env.NAP_CHROME_SMOKE_FAULT === "dimensions")
    act({ action: "zoom", region: [0, 0, 800, 600] });
  const before = await screenshot("before");
  step("Actual Chrome PID, start ticks, socket ownership and initial JPEG checked");

  driver("recording_begin", { recordingId });
  await delay(300);
  const timeBefore = RecordingTimestampSchema.parse(
    driver("recording_timestamp", { recordingId }),
  ).timeMs;
  const text = "Nap 'quoted' $HOME `literal` ; safe";
  act({ action: "left_click", coordinate: await point("#name") });
  act({ action: "type", text });
  act({ action: "left_click", coordinate: await point("button") });
  await until(() => dom().includes(`Applied: ${text}`));
  act({
    action: "scroll",
    scroll_direction: "down",
    scroll_amount: 4,
    coordinate: await point("#scroller"),
  });
  await until(() => /id="scroll-result">Scroll: [1-9][0-9]*/.test(dom()));
  const start = await point("#handle");
  act({
    action: "left_click_drag",
    start_coordinate: start,
    coordinate: [start[0] + 240, start[1]],
  });
  await until(() => /id="drag-result">Drag: 240/.test(dom()));
  const resultDom = dom();
  writeFileSync(`${output}/after-input.txt`, resultDom);
  const after = await screenshot("after-input");
  await delay(300);
  const inputFrameTime = RecordingTimestampSchema.parse(
    driver("recording_timestamp", { recordingId }),
  ).timeMs;
  step("Physical typing, click, scroll and drag changed visible fixture outcomes");

  const passwordBefore = readFileSync(`${DESKTOP_STATE}/password`, "utf8");
  DesktopSizeSchema.parse(driver("start", { port: 5173 }));
  assert.deepEqual(identity(), initial);
  assert.ok(dom().includes(`Applied: ${text}`));
  assert.ok(dom().includes("Drag: 240"));
  assert.ok(
    readFileSync(`${DESKTOP_STATE}/password`, "utf8") === passwordBefore,
    "Same-port startup changed the private credential.",
  );
  step("Same-port start preserved Chrome identity, page state and private credential");

  // Observe the real ownership guard rejecting a mismatched start tick, then restore it.
  writeFileSync(
    `${DESKTOP_STATE}/chrome-owner`,
    `${initial.pid} ${BigInt(initial.ticks) + 1n} 5173\n`,
  );
  try {
    assert.equal(invoke("start", { port: 5173 }).ok, false);
  } finally {
    writeFileSync(`${DESKTOP_STATE}/chrome-owner`, `${initial.record}\n`);
  }
  assert.deepEqual(identity(), initial);
  DesktopSizeSchema.parse(driver("start", { port: 5173 }));
  step("Stale start-tick guard failed closed without killing actual owned Chrome, then recovered");

  await navigate("https://example.com/");
  await until(() => {
    const text = dom();
    return text.includes("This page is blocked") && text.includes("Your organization");
  });
  writeFileSync(`${output}/external-blocked.txt`, dom());
  await screenshot("external-blocked");
  step("External URL refused with Chrome's policy-specific organization error");
  await navigate("http://localhost:5173/");
  await until(() => dom().includes("Origin http://localhost:5173"));

  DesktopSizeSchema.parse(driver("start", { port: 5174 }));
  await until(() => dom().includes("Origin http://localhost:5174"));
  const replacement = identity();
  assert.equal(replacement.port, 5174);
  assert.ok(replacement.pid !== initial.pid || replacement.ticks !== initial.ticks);
  if (existsSync(`/proc/${initial.pid}/stat`)) {
    const old = readFileSync(`/proc/${initial.pid}/stat`, "utf8");
    const fields = old.slice(old.lastIndexOf(") ") + 2).split(" ");
    assert.ok(
      fields[0] === "Z" || fields[19] !== initial.ticks,
      "Previous owned Chrome is still alive.",
    );
  }
  save("policy", JSON.parse(readFileSync("/etc/opt/chrome/policies/managed/nap.json", "utf8")));
  step("Changed port replaced the owned Chrome and loaded current-origin fixture");
  await navigate("http://localhost:5173/");
  await until(() => {
    const text = dom();
    return text.includes("This page is blocked") && text.includes("Your organization");
  });
  writeFileSync(`${output}/old-origin-blocked.txt`, dom());
  await screenshot("old-origin-blocked");
  // The old fixture is reachable inside this same network-none container.
  assert.ok((await fetch("http://localhost:5173/")).ok);
  await navigate("http://127.0.0.1:5174/");
  await until(() => dom().includes("Origin http://127.0.0.1:5174"));
  const current = await screenshot("current-origin");
  step(
    "Reachable previous origin refused by Chrome policy; allowed current loopback origin succeeded",
  );

  const consoleResult = DesktopObservationSchema.parse(act({ action: "console" }));
  assert.equal(consoleResult.kind, "text");
  assert.ok(consoleResult.kind === "text" && consoleResult.text.includes("fixture ready"));
  const timeAfter = RecordingTimestampSchema.parse(
    driver("recording_timestamp", { recordingId }),
  ).timeMs;
  assert.ok(timeBefore > 0 && timeAfter > timeBefore);
  const clip = RecordingVideoSchema.parse(driver("recording_finish", { recordingId }));
  const bytes = Buffer.from(clip.data, "base64");
  assert.equal(bytes.toString("ascii", 4, 8), "ftyp");
  assert.ok(bytes.length > 1000 && clip.durationMs >= timeAfter);
  writeFileSync(`${output}/capture.mp4`, bytes);
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", `${output}/capture.mp4`],
      { encoding: "utf8", timeout: 10000 },
    ),
  );
  save("ffprobe", probe);
  const video = z
    .object({
      streams: z
        .array(
          z.object({
            codec_name: z.string(),
            width: z.number(),
            height: z.number(),
            nb_frames: z.coerce.number(),
          }),
        )
        .length(1),
      format: z.object({ duration: z.coerce.number(), size: z.coerce.number() }),
    })
    .parse(probe);
  assert.equal(video.streams[0]?.codec_name, "h264");
  assert.equal(video.streams[0]?.width, 1024);
  assert.equal(video.streams[0]?.height, 768);
  assert.ok(Number(video.streams[0]?.nb_frames) > 1);
  assert.equal(video.format.size, bytes.length);
  assert.ok(Math.abs(video.format.duration * 1000 - clip.durationMs) <= 125);
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-xerror",
      "-err_detect",
      "explode",
      "-i",
      `${output}/capture.mp4`,
      "-f",
      "null",
      "-",
    ],
    {
      timeout: 30000,
    },
  );
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-xerror",
      "-err_detect",
      "explode",
      "-ss",
      String(inputFrameTime / 1000),
      "-i",
      `${output}/capture.mp4`,
      "-frames:v",
      "1",
      `${output}/video-frame.jpg`,
    ],
    { timeout: 10000 },
  );
  const repeat = RecordingVideoSchema.parse(driver("recording_finish", { recordingId }));
  assert.deepEqual(repeat, clip);
  driver("recording_discard", { recordingId });
  step(
    "Actual ffmpeg MP4 finalized, encoder clock advanced, every frame decoded, repeat finish matched",
  );

  const processes = readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .flatMap((pid) => {
      try {
        return [readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")];
      } catch {
        return [];
      }
    });
  const vnc = processes.find((command) => command[0] === "x11vnc");
  assert.ok(vnc);
  assert.ok(vnc.includes("-localhost"));
  const writableVncControl = process.env.NAP_CHROME_SMOKE_FAULT === "vnc-input";
  assert.equal(vnc.includes("-viewonly"), !writableVncControl);
  assert.ok((await fetch("http://127.0.0.1:6080/vnc.html")).ok);
  const banner = await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket("ws://127.0.0.1:6080/websockify", ["binary"]);
    socket.binaryType = "arraybuffer";
    const deadline = setTimeout(() => {
      socket.close();
      reject(new Error("RFB banner timed out."));
    }, 5000);
    socket.addEventListener("error", () => {
      clearTimeout(deadline);
      reject(new Error("Websockify failed."));
    });
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(deadline);
        resolve(Buffer.from(event.data).toString("ascii"));
        socket.close();
      },
      { once: true },
    );
  });
  assert.match(banner, /^RFB 003\.\d{3}\n$/);
  step(
    writableVncControl
      ? "Writable VNC negative-control flags, noVNC HTTP and RFB banner checked"
      : "View-only localhost x11vnc flags, noVNC HTTP and websockify RFB banner checked",
  );
  save("report", {
    ok: true,
    chromeVersion: execFileSync("google-chrome-stable", ["--version"], { encoding: "utf8" }).trim(),
    nodeVersion: process.version,
    architecture: process.arch,
    cpuMax: readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(),
    memoryMax: readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(),
    memoryPeak: readFileSync("/sys/fs/cgroup/memory.peak", "utf8").trim(),
    memoryEvents: readFileSync("/sys/fs/cgroup/memory.events", "utf8"),
    elapsedMs: Date.now() - started,
    initial,
    replacement,
    jpeg: { before, after, current },
    encoderTimeBeforeMs: timeBefore,
    encoderTimeAfterMs: timeAfter,
    inputFrameTimeMs: inputFrameTime,
    video: {
      bytes: bytes.length,
      durationMs: clip.durationMs,
      frames: video.streams[0]?.nb_frames,
    },
    banner,
    vncServerViewOnly: vnc.includes("-viewonly"),
    steps,
    timings,
  });
  if (process.env.NAP_CHROME_VNC_PROBE === "1") {
    writeFileSync(`${output}/vnc-ready`, "ready\n");
    const deadline = Date.now() + 90000;
    while (!existsSync(`${output}/vnc-finished`) && Date.now() < deadline) await delay(200);
    assert.ok(
      existsSync(`${output}/vnc-finished`),
      "The bounded external VNC probe did not finish.",
    );
  }
} catch (error) {
  writeFileSync(`${output}/last-observed-dom.txt`, lastDom);
  try {
    save("failure-targets", await targets());
    await screenshot("failure-screen");
    save(
      "failure-page",
      await observeActualPage(
        "({title:document.title,visibleText:document.body.innerText,htmlLength:document.documentElement.outerHTML.length,policyErrorOffset:document.documentElement.outerHTML.indexOf('ERR_BLOCKED_BY_ADMINISTRATOR'),policyMessageOffset:document.documentElement.outerHTML.indexOf('This page is blocked')})",
      ),
    );
  } catch {}
  try {
    if (existsSync(`${DESKTOP_STATE}/recordings/${recordingId}/process.json`)) {
      const clip = RecordingVideoSchema.parse(driver("recording_finish", { recordingId }));
      writeFileSync(`${output}/failed-capture.mp4`, Buffer.from(clip.data, "base64"));
      driver("recording_discard", { recordingId });
    }
  } catch {}
  save("failure", {
    message: String(error),
    stack: error instanceof Error ? error.stack : undefined,
    steps,
    timings,
  });
  for (const name of ["chrome", "xvfb", "openbox", "vnc", "websockify"]) {
    const path = `${DESKTOP_STATE}/${name}.log`;
    // x11vnc's startup log can include private credential paths, so retain only Chrome/X11 diagnostics.
    if (existsSync(path) && ["chrome", "xvfb", "openbox"].includes(name))
      writeFileSync(`${output}/${name}.log`, readFileSync(path));
  }
  throw error;
} finally {
  try {
    driver("close_scope");
  } finally {
    fixture.kill();
  }
}
