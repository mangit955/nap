/** Bundled into the sandbox image. All input arrives through the private typed command schema. */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  DESKTOP_HEIGHT,
  DESKTOP_WIDTH,
  DesktopActionSchema,
  type DesktopError,
} from "@nap/shared/ports/sandbox-desktop";

import { observeDesktopPage } from "../src/desktop-cdp.ts";
import { type DesktopActionHost, performDesktopAction } from "../src/desktop-input.ts";
import { DesktopOperations } from "../src/desktop-operations.ts";
import { runDesktopProcess } from "../src/desktop-process.ts";
import {
  DESKTOP_REQUEST_MAX_BASE64_CHARS,
  DESKTOP_STATE,
  DesktopRequestSchema,
  DesktopSizeSchema,
} from "../src/desktop-protocol.ts";
import { DesktopRecorder } from "../src/desktop-recorder.ts";
import { RELEASE_PRESSED_INPUT } from "../src/desktop-release.ts";
import { DesktopScopes } from "../src/desktop-scopes.ts";

const encoded = process.argv[2];
if (!encoded) {
  console.log(
    JSON.stringify({
      protocol: 2,
      operations: [
        "start",
        "act",
        "close_scope",
        "observe",
        "screenshot",
        "credentials",
        "cancel",
        "recording_begin",
        "recording_timestamp",
        "recording_finish",
        "recording_discard",
      ],
    }),
  );
  process.exit(0);
}
const controller = new AbortController();
let errorCode: DesktopError["code"] = "unavailable";
let operationId: string | undefined;
const operations = new DesktopOperations(`${DESKTOP_STATE}/ops`);
const signal = () => controller.abort();
let inputLock: number | undefined;
function run(
  program: string,
  args: readonly string[],
  options: { input?: string; signal?: AbortSignal; maxBytes?: number; inheritInput?: boolean } = {},
): Promise<Buffer> {
  const { inheritInput, ...processOptions } = options;
  return runDesktopProcess(program, args, {
    ...processOptions,
    inputFd: inheritInput ? inputLock : undefined,
  });
}
async function acquireInputLock(): Promise<void> {
  mkdirSync(DESKTOP_STATE, { recursive: true, mode: 0o700 });
  inputLock = openSync(`${DESKTOP_STATE}/action.lock`, "a", 0o600);
  // flock's descriptor 3 and this process refer to the same open file description.
  // Closing the driver cannot unlock an input descendant that still retains it.
  await run("flock", ["-x", "-w", "6", "3"], { inheritInput: true });
}
const scopes = new DesktopScopes(`${DESKTOP_STATE}/scopes`);
function startTicks(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ")[19];
  } catch {
    return undefined;
  }
}
let reply: unknown;
try {
  if (encoded.length > DESKTOP_REQUEST_MAX_BASE64_CHARS || !/^[A-Za-z0-9+/=]+$/.test(encoded))
    throw new Error("Invalid command.");
  const request = DesktopRequestSchema.parse(JSON.parse(Buffer.from(encoded, "base64").toString()));
  process.on("SIGTERM", signal);
  process.on("SIGINT", signal);
  if (request.op === "close_scope") {
    // Revocation must precede lock acquisition, including a delayed original action.
    scopes.close(request.scopeId);
    await acquireInputLock();
    const prior = scopes.proof(request.scopeId, request.sandboxId);
    if (prior) reply = { ok: true, value: prior };
    else {
      await run("python3", ["-c", RELEASE_PRESSED_INPUT], { inheritInput: true });
      reply = { ok: true, value: scopes.drained(request.scopeId, request.sandboxId) };
    }
  } else if (request.op === "cancel") {
    const identity = operations.cancel(request.id);
    if (identity && startTicks(identity.pid) === identity.startTicks) {
      try {
        process.kill(identity.pid, "SIGTERM");
      } catch {
        /* The process may have completed after the identity check. */
      }
    }
    reply = { ok: true, value: { kind: "none" } };
  } else {
    if (request.op === "act") {
      await acquireInputLock();
      if (scopes.closed(request.scopeId)) throw new Error("Input scope is closed.");
    }
    operationId = request.id;
    const ticks = startTicks(process.pid);
    if (!ticks) throw new Error("Cannot identify the desktop process.");
    if (!operations.claim(request.id, { pid: process.pid, startTicks: ticks })) {
      controller.abort();
      controller.signal.throwIfAborted();
    }
    const host: DesktopActionHost = {
      xdotool: async (args, options) => {
        if (request.op === "act" && args[0] === "keydown")
          scopes.hold(request.scopeId, args.slice(1).join("+"));
        return (
          await run("xdotool", args, { ...options, inheritInput: request.op === "act" })
        ).toString();
      },
      sleep: async (ms, abort) => {
        await delay(ms, undefined, abort ? { signal: abort } : undefined);
      },
      observe: (kind) => observeDesktopPage(kind, { signal: controller.signal }),
      zoom: async (region) => {
        writeFileSync(`${DESKTOP_STATE}/zoom.json`, JSON.stringify(region), { mode: 0o600 });
      },
    };
    let value: unknown;
    const recorder = new DesktopRecorder();
    switch (request.op) {
      case "recording_begin":
        await recorder.begin(request.recordingId, controller.signal);
        value = { kind: "none" };
        break;
      case "recording_timestamp":
        value = { timeMs: await recorder.timestamp(request.recordingId) };
        break;
      case "recording_finish": {
        const { bytes, ...metadata } = await recorder.finish(request.recordingId);
        value = { ...metadata, data: Buffer.from(bytes).toString("base64") };
        break;
      }
      case "recording_discard":
        await recorder.discard(request.recordingId);
        value = { kind: "none" };
        break;
      case "start":
        value = DesktopSizeSchema.parse(
          JSON.parse(
            (
              await run("bash", ["/usr/local/bin/nap-desktop-start", String(request.port)], {
                signal: controller.signal,
              })
            ).toString(),
          ),
        );
        break;
      case "observe":
      case "act":
        value = await performDesktopAction(request.action, host, controller.signal);
        if (request.op === "act") {
          // A child can close its pipes before a descriptor-holding descendant exits.
          // Drop only our reference, then acquire a fresh description before success.
          // Never explicitly unlock the old description while descendants may use it.
          if (inputLock === undefined) throw new Error("Input lock was not acquired.");
          closeSync(inputLock);
          inputLock = undefined;
          await acquireInputLock();
          if (scopes.closed(request.scopeId)) throw new Error("Input scope was revoked.");
        }
        break;
      case "credentials":
        if (!existsSync(`${DESKTOP_STATE}/password`)) {
          errorCode = "not_started";
          throw new Error("Desktop not started.");
        }
        value = { password: readFileSync(`${DESKTOP_STATE}/password`, "utf8").trim() };
        break;
      case "screenshot": {
        let width = DESKTOP_WIDTH;
        let height = DESKTOP_HEIGHT;
        const filters: string[] = [];
        const cropPath = `${DESKTOP_STATE}/zoom.json`;
        if (existsSync(cropPath)) {
          const region: unknown = JSON.parse(readFileSync(cropPath, "utf8"));
          rmSync(cropPath);
          const zoom = DesktopActionSchema.parse({ action: "zoom", region });
          if (zoom.action !== "zoom") throw new Error("Invalid crop.");
          const [x, y, right, bottom] = zoom.region;
          width = right - x;
          height = bottom - y;
          filters.push("-vf", `crop=${width}:${height}:${x}:${y}`);
        }
        const bytes = await run(
          "ffmpeg",
          [
            "-nostdin",
            "-loglevel",
            "error",
            "-f",
            "x11grab",
            "-video_size",
            "1024x768",
            "-i",
            ":99",
            ...filters,
            "-frames:v",
            "1",
            "-q:v",
            "3",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "pipe:1",
          ],
          { signal: controller.signal, maxBytes: 2_000_000 },
        );
        value = { width, height, data: bytes.toString("base64") };
        break;
      }
      default: {
        const exhaustive: never = request;
        throw new Error(String(exhaustive));
      }
    }
    controller.signal.throwIfAborted();
    reply = { ok: true, value };
  }
} catch {
  reply = {
    ok: false,
    error: {
      code: controller.signal.aborted ? "cancelled" : errorCode,
      message: controller.signal.aborted
        ? "Desktop operation cancelled."
        : "Desktop operation failed.",
    },
  };
  process.exitCode = 1;
} finally {
  if (operationId) operations.complete(operationId);
  if (inputLock !== undefined) closeSync(inputLock);
  process.removeListener("SIGTERM", signal);
  process.removeListener("SIGINT", signal);
}
console.log(JSON.stringify(reply));
