/**
 * A `SandboxManager` that can only list files.
 *
 * Assembling context is a read-only act: it looks at the shape of the project and nothing
 * else. Every method other than `listFiles` therefore throws, and those throws are the point
 * rather than a shortcut — they turn "the assembler must not run commands, read file
 * contents, or mutate the workspace" from a claim in a comment into something the test suite
 * fails on. A stub that quietly returned empty results for `exec` would let that regression
 * through unnoticed.
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

/** Directory path → its direct children, matching what a real `listFiles` returns. */
export type FileTree = Record<string, FileNode[]>;

export type StubSandboxOptions = {
  /** Paths whose listing fails, so a caller's degradation path can be exercised. */
  failing?: string[];
  /** Receives every path a caller asks to list, so a test can assert on the walk itself. */
  onList?: (path: string) => void;
};

function unreachable(method: string): never {
  throw new Error(`assembling context must not call SandboxManager.${method}`);
}

export function stubSandbox(tree: FileTree, opts: StubSandboxOptions = {}): SandboxManager {
  const failing = new Set(opts.failing ?? []);

  return {
    async listFiles(_sandboxId: string, path: string): Promise<Result<FileNode[], SandboxError>> {
      opts.onList?.(path);
      if (failing.has(path)) {
        return { ok: false, error: { code: "unavailable", message: `cannot list ${path}` } };
      }
      return { ok: true, value: tree[path] ?? [] };
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
