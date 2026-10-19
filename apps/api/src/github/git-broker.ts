import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { decodeRepositoryBundle, encodeRepositoryBundle } from "@nap/sandbox/git-bundle";
import { GitRefSchema } from "@nap/shared/github-protocol";
import type { GitHubResult } from "./app.ts";

const execute = promisify(execFile);
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
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
  constructor(
    readonly options: {
      remoteFor?: (fullName: string) => string;
      allowLocalTransport?: boolean;
    } = {},
  ) {}

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
    const directory = await mkdtemp(join(tmpdir(), "nap-git-"));
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
        const result = await execute(
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
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        );
        return result.stdout.trim();
      };
      await git("init", "--bare", ".");
      return { ok: true, value: await operation(git, directory) };
    } catch {
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
      await rm(directory, { recursive: true, force: true });
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
