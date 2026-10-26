/**
 * A sandbox that is a temporary directory and a real `bash`, for tests whose subject is a shell.
 *
 * `InMemorySandboxManager` answers commands from a script, which is right for nearly every test
 * and useless for these: whether a background shell survives the call that started it, whether
 * a hostile search pattern stays a pattern, whether `find` output parses — those are questions
 * only a real shell can answer. This answers them for free and without a network.
 *
 * The sandbox's absolute paths are *mounted*: `/home/user/app` and the background-shell root are
 * rewritten to directories under a fresh temp directory, in paths and in command text alike, and
 * rewritten back in what a command prints. The rewrite is a plain prefix substitution, which is
 * honest only because the tools under test build their commands from those same constants.
 *
 * Not a conformance-grade sandbox: it serves no preview and has one sandbox. It runs on the
 * host's own utilities, so it can only prove what holds across GNU and BSD userlands alike —
 * the reason the scripts it runs are written against both.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ExecOutputHandler,
  ExecResult,
  FileNode,
  Sandbox,
  SandboxError,
  SandboxManager,
} from "@nap/shared/ports/sandbox-manager";
import type { Result, VoidResult } from "@nap/shared/result";
import { PROJECT_ROOT } from "../tools/definitions.ts";
import { SHELL_ROOT } from "../tools/shell.ts";

export class LocalShellSandbox implements SandboxManager {
  readonly id = "local-shell";
  readonly #mounts: readonly (readonly [string, string])[];

  private constructor(
    readonly root: string,
    readonly prelude: string,
  ) {
    this.#mounts = [
      [PROJECT_ROOT, join(root, "app")],
      [SHELL_ROOT, join(root, "shells")],
    ];
  }

  /**
   * `prelude` runs before every command, in the same shell — how a test takes a program away,
   * by defining a function of the same name, without touching the host.
   */
  static async create(options: { prelude?: string } = {}): Promise<LocalShellSandbox> {
    // Resolved, because macOS's temp directory is a symlink and `pwd` prints the real path —
    // which the reverse mount would then fail to recognise.
    const root = await realpath(await mkdtemp(join(tmpdir(), "nap-shell-")));
    await mkdir(join(root, "app"), { recursive: true });
    await mkdir(join(root, "shells"), { recursive: true });
    return new LocalShellSandbox(root, options.prelude ?? "");
  }

  /** Removes the directory. Background processes a test left running are its own to stop. */
  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  /** Where a sandbox path lives on this host. */
  host(path: string): string {
    return this.#mounts.reduce((text, [inside, outside]) => text.replaceAll(inside, outside), path);
  }

  #guest(text: string): string {
    return this.#mounts.reduce((out, [inside, outside]) => out.replaceAll(outside, inside), text);
  }

  async create(projectId: string): Promise<Result<Sandbox, SandboxError>> {
    return { ok: true, value: { id: this.id, projectId } };
  }

  async resume(sandboxId: string): Promise<Result<Sandbox, SandboxError>> {
    return { ok: true, value: { id: sandboxId, projectId: "local" } };
  }

  async destroy(): Promise<VoidResult<SandboxError>> {
    return { ok: true, value: undefined };
  }

  async extendTimeout(): Promise<VoidResult<SandboxError>> {
    return { ok: true, value: undefined };
  }

  async writeFile(
    _sandboxId: string,
    path: string,
    contents: string,
  ): Promise<VoidResult<SandboxError>> {
    const target = this.host(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
    return { ok: true, value: undefined };
  }

  async readFile(_sandboxId: string, path: string): Promise<Result<string, SandboxError>> {
    try {
      return { ok: true, value: await readFile(this.host(path), "utf8") };
    } catch {
      return { ok: false, error: { code: "file_not_found", message: `${path} does not exist` } };
    }
  }

  async listFiles(_sandboxId: string, path: string): Promise<Result<FileNode[], SandboxError>> {
    try {
      const entries = await readdir(this.host(path), { withFileTypes: true });
      return {
        ok: true,
        value: entries.map((entry) => ({
          path: `${path.replace(/\/$/, "")}/${entry.name}`,
          type: entry.isDirectory() ? "directory" : "file",
        })),
      };
    } catch {
      return { ok: false, error: { code: "file_not_found", message: `${path} does not exist` } };
    }
  }

  exec(
    _sandboxId: string,
    command: string,
    onOutput?: ExecOutputHandler,
    options?: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined },
  ): Promise<Result<ExecResult, SandboxError>> {
    return new Promise((resolve) => {
      const child = spawn("bash", ["-c", `${this.prelude}\n${this.host(command)}`], {
        cwd: join(this.root, "app"),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let stopped: SandboxError | undefined;
      const stop = (error: SandboxError) => {
        stopped = error;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(
        () => stop({ code: "timeout", message: "The command timed out." }),
        options?.timeoutMs ?? 60_000,
      );
      const abort = () => stop({ code: "exec_failed", message: "The command was cancelled." });
      options?.signal?.addEventListener("abort", abort, { once: true });

      child.stdout.setEncoding("utf8").on("data", (data: string) => {
        const text = this.#guest(data);
        stdout += text;
        onOutput?.({ stream: "stdout", data: text });
      });
      child.stderr.setEncoding("utf8").on("data", (data: string) => {
        const text = this.#guest(data);
        stderr += text;
        onOutput?.({ stream: "stderr", data: text });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
        resolve(
          stopped === undefined
            ? { ok: true, value: { exitCode: code ?? 1, stdout, stderr } }
            : { ok: false, error: stopped },
        );
      });
    });
  }

  async getPreviewUrl(): Promise<Result<string, SandboxError>> {
    return { ok: false, error: { code: "unavailable", message: "No preview in a local shell." } };
  }

  async waitForPreview(): Promise<Result<string, SandboxError>> {
    return { ok: false, error: { code: "unavailable", message: "No preview in a local shell." } };
  }
}
