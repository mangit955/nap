import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RecordedVideo } from "@nap/shared/ports/sandbox-recordings";
import { z } from "zod";
import { DESKTOP_STATE } from "./desktop-protocol.ts";

const IdentitySchema = z.strictObject({ pid: z.int().positive(), startTicks: z.string().min(1) });
type ProcessIdentity = z.infer<typeof IdentitySchema>;
const ClipSchema = z.strictObject({
  durationMs: z.int().positive().max(605_000),
  width: z.literal(1024),
  height: z.literal(768),
});
const ActiveSchema = z.strictObject({ recordingId: z.uuid() });
const MAX_BYTES = 16_000_000;
// ffmpeg checks its stop threshold before final packet and MP4 index writes.
const ENCODER_STOP_BYTES = 14_000_000;
export interface RecordingProcessHost {
  start(options: {
    output: string;
    progress: string;
    maxSeconds: number;
    maxBytes: number;
  }): Promise<ProcessIdentity>;
  running(identity: ProcessIdentity): Promise<boolean>;
  stop(identity: ProcessIdentity): Promise<void>;
  probe(file: string): Promise<{ durationMs: number; width: number; height: number }>;
}
function processIdentity(
  pid: number,
): { identity: ProcessIdentity; zombie: boolean; parentPid: number } | undefined {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ");
    const startTicks = fields?.[19];
    return startTicks
      ? {
          identity: { pid, startTicks },
          zombie: fields?.[0] === "Z",
          parentPid: Number(fields?.[1]),
        }
      : undefined;
  } catch {
    return undefined;
  }
}
function alive(identity: ProcessIdentity): boolean {
  const current = processIdentity(identity.pid);
  return (
    current !== undefined && !current.zombie && current.identity.startTicks === identity.startTicks
  );
}
const processes: RecordingProcessHost = {
  start: async ({ output, progress, maxSeconds, maxBytes }) => {
    const child = spawn(
      "timeout",
      [
        "--signal=INT",
        "--kill-after=5",
        String(maxSeconds + 10),
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "x11grab",
        "-video_size",
        "1024x768",
        "-framerate",
        "8",
        "-i",
        ":99",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-bf",
        "0",
        "-crf",
        "30",
        "-pix_fmt",
        "yuv420p",
        "-t",
        String(maxSeconds),
        "-fs",
        String(maxBytes),
        "-movflags",
        "+faststart",
        "-stats_period",
        "0.1",
        "-progress",
        progress,
        output,
      ],
      { detached: true, stdio: "ignore" },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const current = child.pid === undefined ? undefined : processIdentity(child.pid);
    if (!current) {
      child.kill("SIGKILL");
      throw new Error("Capture did not start.");
    }
    const deadline = Date.now() + 2000;
    while (alive(current.identity) && Date.now() < deadline) {
      let children = "";
      try {
        children = readFileSync(
          `/proc/${current.identity.pid}/task/${current.identity.pid}/children`,
          "utf8",
        );
      } catch {
        /* The monitor may have exited. */
      }
      for (const pid of children.trim().split(/\s+/).map(Number)) {
        if (!pid) continue;
        const encoder = processIdentity(pid);
        if (encoder && !encoder.zombie && encoder.parentPid === current.identity.pid) {
          child.unref();
          return encoder.identity;
        }
      }
      await delay(10);
    }
    // This call still owns the monitor's process group before returning an identity.
    if (alive(current.identity)) process.kill(-current.identity.pid, "SIGKILL");
    child.unref();
    throw new Error("Could not identify the capture encoder.");
  },
  running: async (identity) => alive(identity),
  stop: async (identity) => {
    if (!alive(identity)) return;
    process.kill(identity.pid, "SIGINT");
    const deadline = Date.now() + 5000;
    while (alive(identity) && Date.now() < deadline) await delay(50);
    if (alive(identity)) {
      process.kill(identity.pid, "SIGKILL");
      throw new Error("Capture did not drain.");
    }
  },
  probe: async (file) => {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=width,height:format=duration",
          "-of",
          "json",
          file,
        ],
        { encoding: "utf8", timeout: 5000, maxBuffer: 10000 },
        (error, stdout) =>
          error ? reject(new Error("Could not inspect capture.")) : resolve(stdout),
      );
    });
    const parsed = z
      .object({
        streams: z.array(z.object({ width: z.int(), height: z.int() })).length(1),
        format: z.object({ duration: z.string().regex(/^\d+(\.\d+)?$/) }),
      })
      .parse(JSON.parse(output));
    const stream = parsed.streams[0];
    if (!stream) throw new Error("Capture has no video.");
    return { durationMs: Math.round(Number(parsed.format.duration) * 1000), ...stream };
  },
};

/** Short CLI operations share durable process identity; the encoder outlives each operation. */
export class DesktopRecorder {
  readonly #directory: string;
  readonly #host: RecordingProcessHost;
  constructor(options: { directory?: string; host?: RecordingProcessHost } = {}) {
    this.#directory = options.directory ?? join(DESKTOP_STATE, "recordings");
    this.#host = options.host ?? processes;
  }
  #path(id: string): string {
    return join(this.#directory, z.uuid().parse(id));
  }
  #active(): string | undefined {
    const path = join(this.#directory, "active.json");
    return existsSync(path)
      ? ActiveSchema.parse(JSON.parse(readFileSync(path, "utf8"))).recordingId
      : undefined;
  }
  #identity(path: string): ProcessIdentity {
    return IdentitySchema.parse(JSON.parse(readFileSync(join(path, "process.json"), "utf8")));
  }
  #release(id: string): void {
    if (this.#active() === id) rmSync(join(this.#directory, "active.json"), { force: true });
  }
  async begin(id: string, signal?: AbortSignal): Promise<void> {
    const path = this.#path(id);
    signal?.throwIfAborted();
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const active = this.#active();
    if (active && active !== id) {
      if (await this.#host.running(this.#identity(this.#path(active))))
        throw new Error("A recording is active.");
      this.#release(active);
    }
    if (existsSync(join(path, "complete.json"))) return;
    let identity: ProcessIdentity | undefined;
    let spawned = false;
    try {
      if (existsSync(join(path, "process.json"))) {
        identity = this.#identity(path);
        if (!(await this.#host.running(identity))) throw new Error("This recording already ended.");
      } else {
        mkdirSync(path, { recursive: true, mode: 0o700 });
        identity = await this.#host.start({
          output: join(path, "capture.mp4"),
          progress: join(path, "progress"),
          maxSeconds: 600,
          maxBytes: ENCODER_STOP_BYTES,
        });
        spawned = true;
        writeFileSync(join(path, "process.json"), JSON.stringify(identity), { mode: 0o600 });
      }
      writeFileSync(join(this.#directory, "active.json"), JSON.stringify({ recordingId: id }), {
        mode: 0o600,
      });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        if (!(await this.#host.running(identity)))
          throw new Error("Capture stopped before its first frame.");
        try {
          await this.timestamp(id);
          return;
        } catch {
          /* Encoder progress appears after its first frame. */
        }
        await delay(50, undefined, signal ? { signal } : undefined);
      }
      throw new Error("Capture produced no frame.");
    } catch (error) {
      if (!spawned) throw error;
      // The returned identity is authoritative even if persisting it just failed.
      // A failed drain leaves existing recovery files intact for a later cleanup.
      if (identity && (await this.#host.running(identity))) await this.#host.stop(identity);
      rmSync(path, { recursive: true, force: true });
      this.#release(id);
      throw error;
    }
  }
  async timestamp(id: string): Promise<number> {
    const path = this.#path(id);
    if (!(await this.#host.running(this.#identity(path))))
      throw new Error("Capture is not running.");
    const text = readFileSync(join(path, "progress"), "utf8");
    const frames = [...text.matchAll(/^frame=(\d+)\r?\n/gm)].at(-1)?.[1];
    const time = [...text.matchAll(/^out_time_us=(\d+)\r?\n/gm)].at(-1)?.[1];
    if (!frames || Number(frames) < 1 || time === undefined)
      throw new Error("Capture produced no frame.");
    const ms = Math.round(Number(time) / 1000);
    return z.int().nonnegative().max(605_000).parse(ms);
  }
  async finish(id: string): Promise<RecordedVideo> {
    const path = this.#path(id);
    const complete = join(path, "complete.json");
    const identity = this.#identity(path);
    if (await this.#host.running(identity)) await this.#host.stop(identity);
    const file = join(path, "capture.mp4");
    const size = statSync(file).size;
    if (size < 12 || size > MAX_BYTES) throw new Error("Capture size is invalid.");
    const bytes = readFileSync(file);
    if (bytes.toString("ascii", 4, 8) !== "ftyp") throw new Error("Capture is not MP4.");
    const clip = ClipSchema.parse(
      existsSync(complete)
        ? JSON.parse(readFileSync(complete, "utf8"))
        : await this.#host.probe(file),
    );
    writeFileSync(complete, JSON.stringify(clip), { mode: 0o600 });
    this.#release(id);
    return { bytes: Uint8Array.from(bytes), ...clip };
  }
  async discard(id: string): Promise<void> {
    const path = this.#path(id);
    if (existsSync(join(path, "process.json"))) {
      const identity = this.#identity(path);
      if (await this.#host.running(identity)) await this.#host.stop(identity);
    }
    rmSync(path, { recursive: true, force: true });
    this.#release(id);
  }
}
