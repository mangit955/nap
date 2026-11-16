/**
 * An exec channel to a throwaway Linux container, reached the way Harbor's Docker environment
 * reaches a task's machine: `docker exec <container> bash -c <command>`, with stderr folded into
 * stdout as Harbor's environment returns it. For the suites that need a real machine behind
 * `ChannelSandboxManager`; they need Docker, like the `db` suite.
 */

import { execFileSync, spawn } from "node:child_process";
import type { ExecResult, SandboxError } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import type { ExecChannel } from "../exec-channel.ts";

/** Debian, as most Terminal-Bench images are; slim, so it has coreutils and no git or procps. */
export const TASK_LIKE_IMAGE = "debian:bookworm-slim";

/** Starts a container with `workdir` as its working directory. Returns its id. */
export function startContainer(
  workdir: string,
  env: Readonly<Record<string, string>> = {},
): string {
  const flags = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  return execFileSync(
    "docker",
    ["run", "-d", "--rm", "-w", workdir, ...flags, TASK_LIKE_IMAGE, "sleep", "infinity"],
    { encoding: "utf8" },
  ).trim();
}

export function removeContainer(container: string): void {
  execFileSync("docker", ["rm", "-f", container]);
}

export function dockerExecChannel(container: string): ExecChannel {
  return (command, options) =>
    new Promise<Result<ExecResult, SandboxError>>((resolve) => {
      // Both streams on one descriptor of the `docker` process, as Harbor spawns it
      // (`stderr=STDOUT`), so they arrive in the order the client wrote them. Merging two pipes
      // here instead would reorder them at random and test this process, not the adapter.
      const child = spawn(
        "sh",
        ["-c", 'exec docker exec "$0" bash -c "$1" 2>&1', container, command],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (data: string) => {
        stdout += data;
      });
      const timer = setTimeout(() => {
        child.kill();
        resolve({ ok: false, error: { code: "timeout", message: "channel deadline" } });
      }, options?.timeoutMs ?? 120_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ ok: true, value: { exitCode: code ?? 1, stdout, stderr: "" } });
      });
    });
}
