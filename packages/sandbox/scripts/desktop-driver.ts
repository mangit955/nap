/** Bundled into the sandbox image. All input arrives through the private typed command schema. */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import {
  DESKTOP_REQUEST_MAX_BASE64_CHARS,
  DESKTOP_STATE,
  DesktopRequestSchema,
  DesktopSizeSchema,
} from "../src/desktop-protocol.ts";
import { DesktopRecorder } from "../src/desktop-recorder.ts";

const encoded = process.argv[2];
if (!encoded) {
  console.log(
    JSON.stringify({
      protocol: 1,
      operations: [
        "start",
        "act",
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
function run(
  program: string,
  args: readonly string[],
  options: { input?: string; signal?: AbortSignal; maxBytes?: number } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      program,
      [...args],
      {
        env: { ...process.env, DISPLAY: ":99" },
        encoding: "buffer",
        maxBuffer: options.maxBytes ?? 1_000_000,
        timeout: 45000,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout) => (error ? reject(new Error("Desktop process failed.")) : resolve(stdout)),
    );
    child.stdin?.end(options.input ?? "");
  });
}
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
  if (request.op === "cancel") {
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
    operationId = request.id;
    const ticks = startTicks(process.pid);
    if (!ticks) throw new Error("Cannot identify the desktop process.");
    if (!operations.claim(request.id, { pid: process.pid, startTicks: ticks })) {
      controller.abort();
      controller.signal.throwIfAborted();
    }
    process.on("SIGTERM", signal);
    process.on("SIGINT", signal);
    const host: DesktopActionHost = {
      xdotool: async (args, options) => (await run("xdotool", args, options)).toString(),
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
      case "act":
        value = await performDesktopAction(request.action, host, controller.signal);
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
  if (controller.signal.aborted)
    await run("xdotool", [
      "mouseup",
      "1",
      "mouseup",
      "2",
      "mouseup",
      "3",
      "keyup",
      "Shift_L",
      "Shift_R",
      "Control_L",
      "Control_R",
      "Alt_L",
      "Alt_R",
      "Super_L",
      "Super_R",
    ]).catch(() => undefined);
  if (operationId) operations.complete(operationId);
  process.removeListener("SIGTERM", signal);
  process.removeListener("SIGINT", signal);
}
console.log(JSON.stringify(reply));
