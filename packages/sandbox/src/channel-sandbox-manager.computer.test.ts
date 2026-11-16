/**
 * The adapter against a real Linux machine, reached the way Harbor's Docker environment reaches a
 * task's container: `docker exec <container> bash -c <command>`.
 *
 * The unit suite runs the same commands through the host's bash with deadlines switched off,
 * because a host may lack GNU `timeout`. This one is where a deadline is real: a command that
 * overruns must be stopped *inside* the machine, not merely abandoned by the caller, or a hung
 * foreground command keeps running under a task's hidden tests. Needs Docker, like the `db`
 * suite; slow enough to stay out of `test:fast`.
 */

import { execFileSync, spawn } from "node:child_process";
import type { ExecResult, SandboxError } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChannelSandboxManager } from "./channel-sandbox-manager.ts";
import type { ExecChannel } from "./exec-channel.ts";

/** Debian, as most Terminal-Bench images are; slim, so it has coreutils and no git or procps. */
const IMAGE = "debian:bookworm-slim";
const ID = "harbor-task";

let container = "";

beforeAll(() => {
  container = execFileSync(
    "docker",
    ["run", "-d", "--rm", "-w", "/app", IMAGE, "sleep", "infinity"],
    { encoding: "utf8" },
  ).trim();
}, 120_000);

afterAll(() => {
  if (container !== "") execFileSync("docker", ["rm", "-f", container]);
});

/** What Harbor's Docker environment does with `environment.exec`, give or take Compose. */
const dockerChannel: ExecChannel = (command, options) =>
  new Promise<Result<ExecResult, SandboxError>>((resolve) => {
    const child = spawn("docker", ["exec", container, "bash", "-c", command]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (data: string) => {
      stdout += data;
    });
    child.stderr.setEncoding("utf8").on("data", (data: string) => {
      stderr += data;
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: { code: "timeout", message: "channel deadline" } });
    }, options?.timeoutMs ?? 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: true, value: { exitCode: code ?? 1, stdout, stderr } });
    });
  });

const box = () => new ChannelSandboxManager({ sandboxId: ID, channel: dockerChannel });

describe("ChannelSandboxManager in a Linux container", () => {
  it("round-trips bytes through the container's own base64", async () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 7) % 256);
    expect(await box().writeFileBytes(ID, "/app/data/blob.bin", bytes)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await box().readFileBytes(ID, "/app/data/blob.bin")).toEqual({ ok: true, value: bytes });
  }, 30_000);

  it("lists the task's directory with find when there is no git", async () => {
    await box().writeFile(ID, "/app/src/main.py", "print('hi')\n");
    const tree = await box().listTree(ID, "/app", { exclude: [], timeoutMs: 10_000 });
    expect(tree.ok ? tree.value.sort() : tree).toEqual(["/app/data/blob.bin", "/app/src/main.py"]);
  }, 30_000);

  it("runs in the container's working directory", async () => {
    expect(await box().exec(ID, "pwd")).toMatchObject({ ok: true, value: { stdout: "/app\n" } });
  }, 30_000);

  it("stops a command at its deadline inside the machine, not only on this side", async () => {
    const started = Date.now();
    const ran = await box().exec(ID, "sleep 300 # nap-deadline-probe", undefined, {
      timeoutMs: 1_000,
    });
    expect(ran).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(Date.now() - started).toBeLessThan(10_000);

    // No process in the container is still running the command. The bracket keeps the probe's
    // own command line from matching its pattern.
    const survivors = await box().exec(
      ID,
      "grep -l 'nap-deadline-[p]robe' /proc/[0-9]*/cmdline 2>/dev/null || true",
    );
    expect(survivors).toMatchObject({ ok: true, value: { stdout: "" } });
  }, 30_000);
});
