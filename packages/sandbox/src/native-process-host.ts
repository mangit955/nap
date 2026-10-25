/**
 * Runs beside the native agent, so lease expiry still stops it when a worker disappears.
 * Build this entry point for Node before staging it outside the project's writable tree.
 * Process groups are a local-test fallback; production finalization requires cgroup containment.
 */
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  encodeNativeFrame,
  NativeFrameDecoder,
  NativeHostCommandSchema,
  type NativeHostEvent,
  type NativeHostExitReason,
  type NativeHostStart,
  NativeHostStartSchema,
} from "@nap/shared/native-process-protocol";
import { z } from "zod";
import { waitForCgroupEmpty } from "./cgroup-termination.ts";
import { TERMINAL_BRIDGE } from "./terminal-bridge.ts";

const childConfigSchema = NativeHostStartSchema.pick({
  executable: true,
  args: true,
  cwd: true,
  env: true,
}).strip();

// A child joins its root-owned cgroup before spawning user code, then drops privilege.
// Joining after spawn permits a fast descendant to escape into the parent's cgroup.
if (process.argv[2] === "--contained-child") {
  try {
    const root = process.argv[3];
    const uid = z.coerce.number().int().positive().parse(process.argv[4]);
    const gid = z.coerce.number().int().positive().parse(process.argv[5]);
    if (!root) throw new Error("unsupported");
    const config = childConfigSchema.parse(JSON.parse(readFileSync(3, "utf8")));
    writeFileSync(join(root, "cgroup.procs"), String(process.pid));
    // no-new-privs is essential: the template's user may otherwise regain root through sudo.
    const child = spawn(
      "/usr/bin/setpriv",
      [
        `--reuid=${uid}`,
        `--regid=${gid}`,
        "--clear-groups",
        "--no-new-privs",
        "--bounding-set=-all",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--",
        config.executable,
        ...config.args,
      ],
      { cwd: config.cwd, env: config.env, stdio: "inherit" },
    );
    child.on("error", () => process.exit(126));
    child.on("exit", (code) => process.exit(code ?? 128));
  } catch {
    process.exit(126);
  }
} else {
  let config: NativeHostStart | null = null;
  let child: {
    pid: number | undefined;
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
  } | null = null;
  let group: string | null = null;
  let seq = 0;
  let acknowledged = 0;
  let outputBytes = 0;
  let replayBytes = 0;
  const replay: { seq: number; frame: string; bytes: number }[] = [];
  let reason: NativeHostExitReason = "exited";
  let finished = false;
  let stopping = false;
  let lease: ReturnType<typeof setTimeout>;
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  const decoder = new NativeFrameDecoder(NativeHostCommandSchema, 2 * 1024 * 1024);

  function write(frame: string) {
    if (config && process.stdout.writableLength > config.maxReplayBytes + 65536) {
      stop("output_limit");
      return;
    }
    if (!process.stdout.write(frame)) {
      child?.stdout.pause();
      child?.stderr.pause();
    }
  }
  function emit(event: NativeHostEvent) {
    write(encodeNativeFrame(event));
  }
  function signalTree(signal: NodeJS.Signals): boolean {
    try {
      if (group && signal === "SIGKILL") {
        writeFileSync(join(group, "cgroup.kill"), "1");
      } else if (child?.pid) {
        process.kill(-child.pid, signal);
      }
      return true;
    } catch (error) {
      return error instanceof Error && "code" in error && error.code === "ESRCH";
    }
  }
  async function finish(code: number | null) {
    if (finished) return;
    finished = true;
    clearTimeout(lease);
    clearTimeout(forceStop);
    const terminated = signalTree("SIGKILL");
    let containment: "process_group" | "cgroup" | "unknown" = config?.containment.kind ?? "unknown";
    if (!terminated || !child?.pid) containment = "unknown";
    if (group) {
      try {
        if (await waitForCgroupEmpty(group, 1000)) rmdirSync(group);
        else containment = "unknown";
      } catch {
        containment = "unknown";
      }
    }
    emit({ type: "exit", seq: ++seq, code, reason, containment });
    process.stdin.destroy();
    const shutdown = setTimeout(() => process.exit(1), 1000);
    shutdown.unref();
    process.stdout.end(() => {
      clearTimeout(shutdown);
      process.exit(0);
    });
  }
  function stop(nextReason: NativeHostExitReason, signal: NodeJS.Signals = "SIGTERM") {
    if (finished || stopping) return;
    stopping = true;
    reason = nextReason;
    if (!child) {
      finish(null);
      return;
    }
    signalTree(signal);
    forceStop = setTimeout(() => {
      signalTree("SIGKILL");
      // Lost pipes must not keep the supervisor or its lease alive indefinitely.
      forceStop = setTimeout(() => finish(null), 1000);
    }, 100);
  }
  function renew() {
    clearTimeout(lease);
    lease = setTimeout(() => stop("lease_expired"), config?.leaseMs ?? 5000);
  }
  function output(stream: "stdout" | "stderr", bytes: Buffer) {
    if (!config || finished || stopping) return;
    outputBytes += bytes.length;
    if (outputBytes > config.maxOutputBytes) {
      stop("output_limit");
      return;
    }
    // Frames remain bounded even if an implementation delivers one very large chunk.
    for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
      const event: NativeHostEvent = {
        type: "output",
        seq: seq + 1,
        stream,
        data: bytes.subarray(offset, offset + 32 * 1024).toString("base64"),
      };
      const frame = encodeNativeFrame(event);
      const size = Buffer.byteLength(frame);
      if (replayBytes + size > config.maxReplayBytes) {
        stop("replay_limit");
        return;
      }
      seq++;
      replay.push({ seq, frame, bytes: size });
      replayBytes += size;
      write(frame);
    }
  }
  function start(input: NativeHostStart) {
    config = input;
    const launch =
      input.terminal === undefined
        ? { executable: input.executable, args: input.args }
        : {
            executable: "/usr/bin/python3",
            args: [
              "-c",
              TERMINAL_BRIDGE,
              JSON.stringify({
                executable: input.executable,
                args: input.args,
                terminal: input.terminal,
              }),
            ],
          };
    let executable = launch.executable;
    let args = launch.args;
    let cgroupBootstrap: string | undefined;
    if (input.containment.kind === "cgroup") {
      try {
        if (process.platform !== "linux" || process.getuid?.() !== 0)
          throw new Error("unsupported");
        group = join(input.containment.root, `nap-${randomUUID()}`);
        mkdirSync(group, { mode: 0o700 });
        // cgroup.kill is required: process-group signals cannot stop setsid descendants.
        readFileSync(join(group, "cgroup.events"), "utf8");
        writeFileSync(join(group, "cgroup.kill"), "1");
        executable = process.execPath;
        args = [
          fileURLToPath(import.meta.url),
          "--contained-child",
          group,
          String(input.containment.uid),
          String(input.containment.gid),
        ];
        cgroupBootstrap = JSON.stringify(childConfigSchema.parse({ ...input, ...launch }));
      } catch {
        reason = "containment_unavailable";
        finish(null);
        return;
      }
    }
    const spawned = spawn(executable, args, {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    // The first three streams are pipes by construction; avoid casting Node's overload.
    if (!spawned.stdin || !spawned.stdout || !spawned.stderr) {
      spawned.kill("SIGKILL");
      reason = "spawn_failed";
      finish(null);
      return;
    }
    child = {
      pid: spawned.pid,
      stdin: spawned.stdin,
      stdout: spawned.stdout,
      stderr: spawned.stderr,
    };
    if (cgroupBootstrap !== undefined) {
      const channel = spawned.stdio[3];
      if (channel && "end" in channel && typeof channel.end === "function")
        channel.end(cgroupBootstrap);
      else {
        stop("spawn_failed");
        return;
      }
    }
    spawned.once("spawn", () => {
      if (spawned.pid)
        emit({ type: "ready", pid: spawned.pid, containment: input.containment.kind });
    });
    spawned.stdout.on("data", (bytes: Buffer) => output("stdout", bytes));
    spawned.stderr.on("data", (bytes: Buffer) => output("stderr", bytes));
    spawned.stdin.on("error", () => stop("spawn_failed"));
    spawned.stdin.on("drain", () => {
      if (!stopping) process.stdin.resume();
    });
    spawned.once("error", () => {
      reason = "spawn_failed";
      finish(null);
    });
    spawned.once("exit", () => {
      signalTree("SIGKILL");
    });
    spawned.once("close", (code) => finish(code));
    renew();
  }
  process.stdout.on("drain", () => {
    if (!stopping) {
      child?.stdout.resume();
      child?.stderr.resume();
    }
  });
  process.stdout.on("error", () => {
    signalTree("SIGKILL");
    process.exit(1);
  });
  process.stdin.on("data", (chunk: Buffer) => {
    try {
      for (const command of decoder.push(chunk)) {
        if (!config) {
          if (command.type !== "start") {
            stop("protocol_error");
            return;
          }
          start(command);
          continue;
        }
        if (
          !timingSafeEqual(Buffer.from(command.token), Buffer.from(config.token)) ||
          command.type === "start"
        ) {
          stop("protocol_error");
          return;
        }
        switch (command.type) {
          case "input": {
            const data =
              config.terminal === undefined
                ? command.data
                : encodeNativeFrame({ type: "input", data: command.data });
            if (child && !child.stdin.write(data)) process.stdin.pause();
            if (child && child.stdin.writableLength > 2 * 1024 * 1024) stop("input_limit");
            break;
          }
          case "resize":
            if (config.terminal === undefined) {
              stop("protocol_error");
              return;
            }
            if (
              child &&
              !child.stdin.write(
                encodeNativeFrame({ type: "resize", columns: command.columns, rows: command.rows }),
              )
            )
              process.stdin.pause();
            if (child && child.stdin.writableLength > 2 * 1024 * 1024) stop("input_limit");
            break;
          case "renew":
            if (!stopping) renew();
            break;
          case "interrupt":
            stop("interrupted", "SIGINT");
            break;
          case "stop":
            stop("stopped");
            break;
          case "ack": {
            if (command.sequence < acknowledged || command.sequence > seq) {
              stop("protocol_error");
              break;
            }
            acknowledged = command.sequence;
            while (replay[0] && replay[0].seq <= acknowledged)
              replayBytes -= replay.shift()?.bytes ?? 0;
            break;
          }
          case "replay": {
            if (command.afterSequence < acknowledged || command.afterSequence > seq) {
              stop("replay_unavailable");
              break;
            }
            for (const event of replay) if (event.seq > command.afterSequence) write(event.frame);
            break;
          }
        }
      }
    } catch {
      stop("protocol_error");
    }
  });
  process.stdin.on("end", () => stop("controller_closed"));
  process.stdin.on("error", () => stop("controller_closed"));
  process.on("SIGTERM", () => stop("controller_closed"));
  process.on("SIGINT", () => stop("controller_closed"));
  lease = setTimeout(() => stop("lease_expired"), 5000);
}
