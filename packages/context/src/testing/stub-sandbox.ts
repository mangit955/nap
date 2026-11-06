/**
 * A `SandboxManager` that can only list a workspace, once per question.
 *
 * Assembling context is a read-only act: it looks at the shape of the project and nothing
 * else. Every method other than `listTree` therefore throws, and those throws are the point
 * rather than a shortcut — they turn "the assembler must not run commands, read file
 * contents, mutate the workspace, or walk it a folder at a time" from a claim in a comment into
 * something the test suite fails on. A stub that quietly returned empty results for `exec` or
 * `listFiles` would let that regression through unnoticed.
 *
 * This lives here, small and local, instead of reaching for the full in-memory fake next
 * door: the fake belongs to the sandbox package, and this package is not allowed to depend
 * on it — they are siblings (docs/PLAN.md §0).
 */

import type {
  ExecResult,
  FileNode,
  Sandbox,
  SandboxError,
  SandboxManager,
} from "@nap/shared/ports/sandbox-manager";
import type { Result, VoidResult } from "@nap/shared/result";

/** Every file in the workspace, by absolute path — what a real sandbox holds, before filtering. */
export type Workspace = readonly string[];

/** One `listTree` call, as it was asked. */
export type ListTreeCall = { root: string; exclude: readonly string[]; timeoutMs: number };

export type StubSandboxOptions = {
  /** The listing fails, so a caller's degradation path can be exercised. */
  failing?: boolean;
  /** Receives every listing a caller asks for, so a test can hold it to one per build. */
  onListTree?: (call: ListTreeCall) => void;
};

function unreachable(method: string): never {
  throw new Error(`assembling context must not call SandboxManager.${method}`);
}

export function stubSandbox(workspace: Workspace, opts: StubSandboxOptions = {}): SandboxManager {
  return {
    async listTree(
      _sandboxId: string,
      root: string,
      options: { exclude: readonly string[]; timeoutMs: number },
    ): Promise<Result<string[], SandboxError>> {
      opts.onListTree?.({ root, exclude: options.exclude, timeoutMs: options.timeoutMs });
      if (opts.failing === true) {
        return { ok: false, error: { code: "timeout", message: `listing ${root} timed out` } };
      }
      // The port's promise, kept here too: nothing under an excluded segment comes back.
      const prefix = root.endsWith("/") ? root : `${root}/`;
      const excluded = new Set(options.exclude);
      return {
        ok: true,
        value: workspace.filter(
          (path) =>
            path.startsWith(prefix) &&
            !path
              .slice(prefix.length)
              .split("/")
              .some((segment) => excluded.has(segment)),
        ),
      };
    },

    async listFiles(): Promise<Result<FileNode[], SandboxError>> {
      return unreachable("listFiles");
    },
    async create(): Promise<Result<Sandbox, SandboxError>> {
      return unreachable("create");
    },
    async resume(): Promise<Result<Sandbox, SandboxError>> {
      return unreachable("resume");
    },
    async destroy(): Promise<VoidResult<SandboxError>> {
      return unreachable("destroy");
    },
    async extendTimeout(): Promise<VoidResult<SandboxError>> {
      return unreachable("extendTimeout");
    },
    async writeFile(): Promise<VoidResult<SandboxError>> {
      return unreachable("writeFile");
    },
    async readFile(): Promise<Result<string, SandboxError>> {
      return unreachable("readFile");
    },
    async writeFileBytes(): Promise<VoidResult<SandboxError>> {
      return unreachable("writeFileBytes");
    },
    async readFileBytes(): Promise<Result<Uint8Array, SandboxError>> {
      return unreachable("readFileBytes");
    },
    async exec(): Promise<Result<ExecResult, SandboxError>> {
      return unreachable("exec");
    },
    async getPreviewUrl(): Promise<Result<string, SandboxError>> {
      return unreachable("getPreviewUrl");
    },
    async waitForPreview(): Promise<Result<string, SandboxError>> {
      return unreachable("waitForPreview");
    },
  };
}
