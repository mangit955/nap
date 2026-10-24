/** Bundled into the sandbox image. All input arrives through the private typed command schema. */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  DESKTOP_HEIGHT,
  DESKTOP_WIDTH,
  DesktopActionSchema,
  type DesktopError,
} from "@nap/shared/ports/sandbox-desktop";
import { z } from "zod";
import { observeDesktopPage } from "../src/desktop-cdp.ts";
import { type DesktopActionHost, performDesktopAction } from "../src/desktop-input.ts";
import { DESKTOP_STATE, DesktopRequestSchema, DesktopSizeSchema } from "../src/desktop-protocol.ts";

const encoded = process.argv[2];
if (!encoded) {
  console.log(
    JSON.stringify({
      protocol: 1,
      operations: ["start", "act", "screenshot", "credentials", "cancel"],
    }),
  );
  process.exit(0);
}
const controller = new AbortController();
let errorCode: DesktopError["code"] = "unavailable";
let operationPath: string | undefined;
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
  if (encoded.length > 30000 || !/^[A-Za-z0-9+/=]+$/.test(encoded))
    throw new Error("Invalid command.");
  const request = DesktopRequestSchema.parse(JSON.parse(Buffer.from(encoded, "base64").toString()));
  if (request.op === "cancel") {
    const path = `${DESKTOP_STATE}/ops/${request.id}.json`;
    if (existsSync(path)) {
      const identity = z
        .object({ pid: z.int().positive(), startTicks: z.string() })
        .parse(JSON.parse(readFileSync(path, "utf8")));
      if (startTicks(identity.pid) === identity.startTicks) {
        try {
          process.kill(identity.pid, "SIGTERM");
        } catch {
          /* The process may have completed between identity check and signal. */
        }
      }
    }
    reply = { ok: true, value: { kind: "none" } };
  } else {
    mkdirSync(`${DESKTOP_STATE}/ops`, { recursive: true, mode: 0o700 });
    operationPath = `${DESKTOP_STATE}/ops/${request.id}.json`;
    writeFileSync(
      operationPath,
      JSON.stringify({ pid: process.pid, startTicks: startTicks(process.pid) }),
      { mode: 0o600 },
    );
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
    switch (request.op) {
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
  if (operationPath) rmSync(operationPath, { force: true });
  process.removeListener("SIGTERM", signal);
  process.removeListener("SIGINT", signal);
}
console.log(JSON.stringify(reply));
