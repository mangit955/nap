import { type ChildProcess, execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { decodeRepositoryBundle, encodeRepositoryBundle } from "@nap/sandbox/git-bundle";
import { GitRefSchema } from "@nap/shared/github-protocol";
import { getLogger } from "@nap/shared/logging";
import type { GitHubResult } from "./app.ts";

const execute = promisify(execFile);
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
/**
 * The most one transfer may write to this process's temporary disk.
 *
 * The bundle limit is checked only once the bundle exists, and getting there means fetching every
 * branch and tag first — so without this a large repository fills the worker's disk before it is
 * refused, and every turn on that worker fails with it. A fetched pack plus the bundle made from
 * it is about twice the bundle, so four times leaves room without letting a repository many times
 * the limit through.
 */
const MAX_WORKING_BYTES = 4 * MAX_BUNDLE_BYTES;
/** How many transfers may hold temporary disk at once, so the bound above is a bound per process. */
const MAX_CONCURRENT_TRANSFERS = 2;
const WATCH_EVERY_MS = 200;
/** How long a stopped Git may take to exit before it is killed outright. */
const EXIT_GRACE_MS = 5_000;
const REMOVE_ATTEMPTS = 5;
const REMOVE_RETRY_MS = 100;
type Transfer = {
  fullName: string;
  branch: string;
  token: string;
  signal?: AbortSignal | undefined;
};
export interface GitBroker {
  fetch(options: Transfer): Promise<GitHubResult<Uint8Array>>;
  push(options: Transfer & { bytes: Uint8Array; sha: string }): Promise<GitHubResult<void>>;
}

export class ServerGitBroker implements GitBroker {
  readonly #waiting: (() => void)[] = [];
  #active = 0;

  constructor(
    readonly options: {
      remoteFor?: (fullName: string) => string;
      allowLocalTransport?: boolean;
      maxWorkingBytes?: number;
      maxConcurrent?: number;
      /** Where working directories are made; the system's by default. */
      temporaryRoot?: string;
    } = {},
  ) {}

  /** Waits for a transfer slot; false when cancelled while waiting. */
  async #acquire(signal: AbortSignal | undefined): Promise<boolean> {
    if (this.#active < (this.options.maxConcurrent ?? MAX_CONCURRENT_TRANSFERS)) {
      this.#active += 1;
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      const granted = () => {
        signal?.removeEventListener("abort", cancelled);
        resolve(true);
      };
      const cancelled = () => {
        const index = this.#waiting.indexOf(granted);
        if (index !== -1) this.#waiting.splice(index, 1);
        resolve(false);
      };
      this.#waiting.push(granted);
      signal?.addEventListener("abort", cancelled, { once: true });
    });
  }

  #release(): void {
    const next = this.#waiting.shift();
    // Handed straight to the next waiter, so the count never dips and lets a third in.
    if (next !== undefined) next();
    else this.#active -= 1;
  }

  async #withGit<T>(
    options: Transfer,
    operation: (git: (...args: string[]) => Promise<string>, directory: string) => Promise<T>,
  ): Promise<GitHubResult<T>> {
    if (options.signal?.aborted)
      return { ok: false, error: { code: "cancelled", message: "Repository transfer cancelled." } };
    if (
      !GitRefSchema.safeParse(options.branch).success ||
      !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(options.fullName)
    ) {
      return {
        ok: false,
        error: { code: "access_denied", message: "Invalid repository or branch." },
      };
    }
    if (!(await this.#acquire(options.signal)))
      return { ok: false, error: { code: "cancelled", message: "Repository transfer cancelled." } };
    let directory: string;
    try {
      directory = await mkdtemp(join(this.options.temporaryRoot ?? tmpdir(), "nap-git-"));
    } catch (error) {
      this.#release();
      throw error;
    }
    const limit = new AbortController();
    const signal =
      options.signal === undefined ? limit.signal : AbortSignal.any([options.signal, limit.signal]);
    const allowance = this.options.maxWorkingBytes ?? MAX_WORKING_BYTES;
    let oversized = false;
    // Sampled while Git runs, to stop a download partway; and checked after every step, because
    // a fast transfer can finish between two samples.
    const watcher = setInterval(() => {
      void directorySize(directory).then((bytes) => {
        // A Git already stopped by its caller may still write while it exits; that is a
        // cancellation, not a repository too large to import.
        if (bytes <= allowance || signal.aborted) return;
        oversized = true;
        limit.abort();
      });
    }, WATCH_EVERY_MS);
    try {
      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: directory,
        XDG_CONFIG_HOME: directory,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        // The token exists only in this child's environment. Never copy the parent environment.
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${options.token}`).toString("base64")}`,
      };
      const git = async (...args: string[]) => {
        const running = execute(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            "-c",
            "protocol.ext.allow=never",
            "-c",
            `protocol.file.allow=${this.options.allowLocalTransport === true ? "always" : "never"}`,
            "-c",
            "http.followRedirects=false",
            "-c",
            "transfer.fsckObjects=true",
            ...args,
          ],
          {
            cwd: directory,
            env,
            timeout: 120_000,
            maxBuffer: 2 * 1024 * 1024,
            signal,
          },
        );
        let stdout: string;
        try {
          ({ stdout } = await running);
        } finally {
          // A stopped Git rejects at once but exits later, still writing; nothing may clean up
          // or start the next step under it.
          await exited(running.child);
        }
        if ((await directorySize(directory)) > allowance) {
          oversized = true;
          throw new Error("transfer exceeded its disk allowance");
        }
        return stdout.trim();
      };
      await git("init", "--bare", ".");
      return { ok: true, value: await operation(git, directory) };
    } catch {
      if (oversized)
        return {
          ok: false,
          error: {
            code: "conflict",
            message: `This repository is too large to import. Nap supports repositories whose history bundles to ${MAX_BUNDLE_BYTES / 1024 / 1024} MiB or less.`,
          },
        };
      return options.signal?.aborted
        ? { ok: false, error: { code: "cancelled", message: "Repository transfer cancelled." } }
        : {
            ok: false,
            error: {
              code: "conflict",
              message:
                "Git transfer failed. Check repository access, size, and whether the remote branch has changed. No force push was attempted.",
            },
          };
    } finally {
      clearInterval(watcher);
      try {
        await removeWorkingDirectory(directory);
      } catch (error) {
        // Thrown from here it would replace the answer above and keep the slot forever.
        getLogger().warn({ err: error, directory }, "could not remove a Git working directory");
      } finally {
        this.#release();
      }
    }
  }

  fetch(options: Transfer): Promise<GitHubResult<Uint8Array>> {
    return this.#withGit(options, async (git, directory) => {
      await git(
        "fetch",
        "--no-recurse-submodules",
        "--tags",
        this.#remote(options.fullName),
        "+refs/heads/*:refs/heads/*",
      );
      await git("rev-parse", "--verify", `refs/heads/${options.branch}^{commit}`);
      await git("symbolic-ref", "HEAD", `refs/heads/${options.branch}`);
      const path = join(directory, "repository.bundle");
      await git("bundle", "create", path, "--all", "HEAD");
      if ((await stat(path)).size > MAX_BUNDLE_BYTES) throw new Error("repository too large");
      return encodeRepositoryBundle(
        new Uint8Array(await readFile(path)),
        `refs/heads/${options.branch}`,
      );
    });
  }

  push(options: Transfer & { bytes: Uint8Array; sha: string }): Promise<GitHubResult<void>> {
    return this.#withGit(options, async (git, directory) => {
      const decoded = decodeRepositoryBundle(options.bytes);
      if (
        !decoded.ok ||
        options.bytes.length > MAX_BUNDLE_BYTES ||
        !/^[a-f0-9]{40,64}$/.test(options.sha) ||
        !options.branch.startsWith("nap/")
      )
        throw new Error("invalid publication");
      if (decoded.value.head !== `refs/heads/${options.branch}`)
        throw new Error("workspace changed branch");
      const path = join(directory, "repository.bundle");
      await writeFile(path, decoded.value.bundle);
      await git(
        "-c",
        "protocol.file.allow=always",
        "fetch",
        "--no-recurse-submodules",
        path,
        `refs/heads/${options.branch}:refs/heads/${options.branch}`,
      );
      if ((await git("rev-parse", `refs/heads/${options.branch}`)) !== options.sha)
        throw new Error("workspace changed commit");
      await git(
        "push",
        "--porcelain",
        this.#remote(options.fullName),
        `refs/heads/${options.branch}:refs/heads/${options.branch}`,
      );
    });
  }

  #remote(fullName: string): string {
    return this.options.remoteFor?.(fullName) ?? `https://github.com/${fullName}.git`;
  }
}

/** Resolves once a child has exited, killing it outright if it outlasts the grace period. */
function exited(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.off("exit", done);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done();
    }, EXIT_GRACE_MS);
    child.once("exit", done);
  });
}

/**
 * Removes a working directory, retrying while it is not yet empty: Git's own helpers, such as
 * the one writing the pack, can outlive a stopped Git by a moment.
 */
async function removeWorkingDirectory(directory: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= REMOVE_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, REMOVE_RETRY_MS * attempt));
    }
  }
}

/** Bytes under a directory. A file vanishing mid-walk is Git renaming a temporary pack. */
async function directorySize(directory: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      total += await stat(join(entry.parentPath, entry.name)).then(
        (info) => info.size,
        () => 0,
      );
    }
  } catch {
    // The directory is being removed; there is nothing left to bound.
  }
  return total;
}
