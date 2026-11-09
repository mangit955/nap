/**
 * The dependency cache's scripts against a real shell, real git, real tar and a real filesystem.
 *
 * The fake-level tests pin which commands are sent; only running them can say whether they do what
 * they claim — that an archive extracts to the tree it was made from, that a corrupt one leaves the
 * dependencies alone, that a tree moved after the install is refused. `bun` is a shim on PATH, so
 * "installing" writes a known tree and nothing touches the network.
 */

import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ExecResult, SandboxError } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveDependencies,
  DEPENDENCY_KEY_PROBE,
  extractDependencies,
  installDependencies,
  readDependencyKey,
  stageDependencyArchive,
} from "./dependency-cache.ts";
import { InMemorySandboxManager } from "./testing/in-memory-sandbox-manager.ts";
import { localGitEnvironment } from "./testing/local-git-environment.ts";

const run = promisify(execFile);
let directory: string;
let project: string;
let scratch: string;
let shims: string;

class LocalSandbox extends InMemorySandboxManager {
  override async exec(_id: string, command: string): Promise<Result<ExecResult, SandboxError>> {
    try {
      const result = await run("bash", ["-c", command], { env: environment() });
      return { ok: true, value: { ...result, exitCode: 0 } };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return {
        ok: true,
        value: {
          exitCode: typeof failed.code === "number" ? failed.code : 1,
          stdout: failed.stdout ?? "",
          stderr: failed.stderr ?? String(error),
        },
      };
    }
  }
  override async writeFileBytes(_id: string, path: string, contents: Uint8Array) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
    return { ok: true as const, value: undefined };
  }
  override async readFileBytes(_id: string, path: string) {
    return { ok: true as const, value: new Uint8Array(await readFile(path)) };
  }
}

function environment(): NodeJS.ProcessEnv {
  const base = localGitEnvironment(directory);
  return { ...base, PATH: `${shims}:${base.PATH}` };
}

const options = () => ({ cwd: project, scratch });

async function sh(command: string, cwd = project): Promise<string> {
  const result = await run("bash", ["-c", command], { cwd, env: environment() });
  return result.stdout.trim();
}

/** Every path under node_modules with its contents or link target, as one comparable string. */
async function treeOf(root: string): Promise<string> {
  return sh(
    "find node_modules -mindepth 1 | LC_ALL=C sort | while read -r p; do " +
      'if [ -L "$p" ]; then echo "$p -> $(readlink "$p")"; ' +
      'elif [ -f "$p" ]; then echo "$p $(cat "$p")"; else echo "$p/"; fi; done',
    root,
  );
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "nap-deps-"));
  project = join(directory, "app");
  scratch = join(directory, "scratch");
  shims = join(directory, "bin");
  await mkdir(project);
  await mkdir(shims);
  // `bun install` lays down the tree the lockfile names; `bun --revision` is the toolchain.
  await writeFile(
    join(shims, "bun"),
    [
      "#!/bin/sh",
      'if [ "$1" = "--revision" ]; then echo "1.0.0+shim"; exit 0; fi',
      'if [ "$1" = "install" ]; then',
      "  mkdir -p node_modules/left-pad node_modules/.bin",
      '  echo "module.exports = $(cat bun.lock)" > node_modules/left-pad/index.js',
      "  ln -sf ../left-pad/index.js node_modules/.bin/left-pad",
      '  echo "installed"; exit 0',
      "fi",
      "exit 1",
    ].join("\n"),
  );
  await chmod(join(shims, "bun"), 0o755);
  await sh("git init -q -b main");
  await writeFile(join(project, ".gitignore"), "node_modules\n");
  await writeFile(join(project, "package.json"), '{"dependencies":{"left-pad":"1"}}\n');
  await writeFile(join(project, "bun.lock"), "1\n");
  await sh("git add . && git commit -q -m Initial");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("DEPENDENCY_KEY_PROBE", () => {
  const key = async () => readDependencyKey(await sh(DEPENDENCY_KEY_PROBE));

  it("reads a sha256 of the committed install inputs", async () => {
    expect(await key()).toMatch(/^[0-9a-f]{64}$/);
    expect(await key()).toBe(await key());
  });

  it.each([
    ["the lockfile", "bun.lock", "2\n"],
    ["package.json", "package.json", '{"dependencies":{"left-pad":"2"}}\n'],
    ["a bunfig.toml that is new", "bunfig.toml", "[install]\n"],
  ])("changes when %s is committed with new contents", async (_, file, contents) => {
    const before = await key();

    await writeFile(join(project, file), contents);
    await sh("git add . && git commit -q -m Change");

    expect(await key()).not.toBe(before);
  });

  it("does not change for a source file", async () => {
    const before = await key();

    await writeFile(join(project, "app.ts"), "export {};\n");
    await sh("git add . && git commit -q -m Source");

    expect(await key()).toBe(before);
  });
});

describe("a dependency archive's round trip", () => {
  it("extracts to exactly the tree the install left, links included, keeping the old tree's caches", async () => {
    const manager = new LocalSandbox();
    const installed = await installDependencies(manager, "sandbox", {
      ...options(),
      timeoutMs: 10_000,
    });
    expect(installed).toMatchObject({ ok: true, value: { exitCode: 0 } });
    if (!installed.ok) return;
    expect(installed.value.key).toBe(readDependencyKey(await sh(DEPENDENCY_KEY_PROBE)));
    // A cache the dev server writes after the install is not part of the archive, and not a reason
    // to refuse one.
    await mkdir(join(project, "node_modules", ".vite"));
    await writeFile(join(project, "node_modules", ".vite", "deps.json"), "source's cache");
    const expected = await treeOf(project);

    const archive = await archiveDependencies(manager, "sandbox", {
      ...options(),
      maxBytes: 1 << 20,
    });
    if (!archive.ok) throw new Error(archive.error.message);

    // A second sandbox: the template's own dependencies, and its own dev server cache.
    const restored = join(directory, "restored");
    await mkdir(join(restored, "node_modules", "template-only"), { recursive: true });
    await mkdir(join(restored, "node_modules", ".vite"));
    await writeFile(join(restored, "node_modules", ".vite", "deps.json"), "restored's cache");
    const staged = await stageDependencyArchive(manager, "other", archive.value, { scratch });
    expect(staged.ok).toBe(true);
    const extracted = await extractDependencies(manager, "other", { cwd: restored, scratch });

    expect(extracted).toEqual({ ok: true, value: undefined });
    expect(await treeOf(restored)).toBe(expected.replace("source's cache", "restored's cache"));
    expect(await readlink(join(restored, "node_modules", ".bin", "left-pad"))).toBe(
      "../left-pad/index.js",
    );
    // Nothing is left behind to be uploaded twice or to fill the disk. (`installed` is the source
    // sandbox's record of its install; the two share a scratch directory only in this test.)
    expect(await sh("ls -A", scratch)).toBe("installed");
  });

  it("leaves the dependencies alone when the archive is corrupt", async () => {
    const manager = new LocalSandbox();
    await mkdir(join(project, "node_modules", "template-only"), { recursive: true });
    await writeFile(join(project, "node_modules", "template-only", "index.js"), "baked");
    const before = await treeOf(project);
    await stageDependencyArchive(manager, "sandbox", new TextEncoder().encode("not a tarball"), {
      scratch,
    });

    const extracted = await extractDependencies(manager, "sandbox", options());

    expect(extracted).toMatchObject({ ok: false, error: { code: "exec_failed" } });
    expect(await treeOf(project)).toBe(before);
  });

  it("refuses to extract an archive with no node_modules in it", async () => {
    const manager = new LocalSandbox();
    await mkdir(join(project, "node_modules", "kept"), { recursive: true });
    const empty = join(directory, "empty");
    await mkdir(join(empty, "other"), { recursive: true });
    await sh(`tar -czf ${join(directory, "empty.tar.gz")} other`, empty);
    await stageDependencyArchive(
      manager,
      "sandbox",
      new Uint8Array(await readFile(join(directory, "empty.tar.gz"))),
      { scratch },
    );

    const extracted = await extractDependencies(manager, "sandbox", options());

    expect(extracted.ok).toBe(false);
    expect(await sh("ls -A node_modules")).toBe("kept");
  });
});

describe("archiveDependencies refuses a tree that is not the install's", () => {
  async function install(manager: LocalSandbox) {
    const installed = await installDependencies(manager, "sandbox", {
      ...options(),
      timeoutMs: 10_000,
    });
    if (!installed.ok || installed.value.exitCode !== 0) throw new Error("install failed");
    // Timestamps have a granularity; a change made in the same tick as the install would be
    // invisible, and no real edit lands that fast.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  it("when nothing was ever installed", async () => {
    await mkdir(join(project, "node_modules", "left-pad"), { recursive: true });

    const archive = await archiveDependencies(new LocalSandbox(), "sandbox", {
      ...options(),
      maxBytes: 1 << 20,
    });

    expect(archive.ok).toBe(false);
  });

  it("when a file in it was edited after the install", async () => {
    const manager = new LocalSandbox();
    await install(manager);
    await writeFile(join(project, "node_modules", "left-pad", "index.js"), "patched by hand");

    const archive = await archiveDependencies(manager, "sandbox", {
      ...options(),
      maxBytes: 1 << 20,
    });

    expect(archive.ok).toBe(false);
  });

  it("when a package was removed after the install", async () => {
    const manager = new LocalSandbox();
    await install(manager);
    await rm(join(project, "node_modules", "left-pad"), { recursive: true });
    await rm(join(project, "node_modules", ".bin"), { recursive: true });

    const archive = await archiveDependencies(manager, "sandbox", {
      ...options(),
      maxBytes: 1 << 20,
    });

    expect(archive.ok).toBe(false);
  });

  it("when a package was added after the install", async () => {
    const manager = new LocalSandbox();
    await install(manager);
    await mkdir(join(project, "node_modules", "added-later"));

    const archive = await archiveDependencies(manager, "sandbox", {
      ...options(),
      maxBytes: 1 << 20,
    });

    expect(archive.ok).toBe(false);
  });

  it("when it is larger than the bound, leaving nothing behind", async () => {
    const manager = new LocalSandbox();
    await install(manager);

    const archive = await archiveDependencies(manager, "sandbox", { ...options(), maxBytes: 10 });

    expect(archive.ok).toBe(false);
    expect(await sh(`ls -A ${scratch} | grep -c outgoing || true`)).toBe("0");
  });
});

it("installDependencies reports no key when the install failed", async () => {
  await writeFile(join(shims, "bun"), '#!/bin/sh\n[ "$1" = "--revision" ] && echo r\nexit 3\n');

  const installed = await installDependencies(new LocalSandbox(), "sandbox", {
    ...options(),
    timeoutMs: 10_000,
  });

  expect(installed).toMatchObject({ ok: true, value: { exitCode: 3, key: null } });
  // No record of a successful install, so nothing can be archived from this tree.
  await expect(readFile(join(scratch, "installed"))).rejects.toThrow();
});

it("is collected with a symlink target we can read", async () => {
  // Guards the helper above: `treeOf` must see links as links, or the round trip proves nothing.
  await mkdir(join(project, "node_modules"));
  await symlink("target", join(project, "node_modules", "link"));
  expect(await treeOf(project)).toBe("node_modules/link -> target");
});
