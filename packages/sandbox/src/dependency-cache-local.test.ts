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
  archivePackageCache,
  DEPENDENCY_KEY_PROBE,
  extractDependencies,
  extractPackageCache,
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
  // `bun install` lays down the tree the lockfile names, "downloading" left-pad into its package
  // cache first; `--offline` refuses unless the cache already holds it, as Bun's does. `bun pm
  // cache` names that cache, and `bun --revision` is the toolchain.
  await writeFile(
    join(shims, "bun"),
    [
      "#!/bin/sh",
      `cache=${JSON.stringify(join(directory, "bun-cache"))}`,
      'if [ "$1" = "--revision" ]; then echo "1.0.0+shim"; exit 0; fi',
      'if [ "$1 $2" = "pm cache" ]; then printf %s "$cache"; exit 0; fi',
      'if [ "$1" = "install" ]; then',
      '  case " $* " in',
      // A scoped package lives a level down, in a scope directory the image's cache may already have.
      '    *" --offline "*) [ -f "$cache/left-pad@1/index.js" ] && [ -f "$cache/@types/debug@1/index.d.ts" ] || { echo "offline: not in the cache" >&2; exit 1; } ;;',
      '    *) mkdir -p "$cache/left-pad@1" "$cache/@types/debug@1" && echo "module.exports = 1" > "$cache/left-pad@1/index.js" && touch "$cache/left-pad.npm" "$cache/@types/debug@1/index.d.ts" ;;',
      "  esac",
      "  mkdir -p node_modules/left-pad node_modules/.bin",
      '  echo "module.exports = $(cat bun.lock)" > node_modules/left-pad/index.js',
      "  ln -sf ../left-pad/index.js node_modules/.bin/left-pad",
      // What a test wants this install to do besides: rewrite its inputs, run a script.
      "  if [ -f ../install-hook.sh ]; then . ../install-hook.sh; fi",
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
    expect(installed).toMatchObject({ ok: true, value: { exitCode: 0, cache: "node_modules" } });
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
    // Nothing is left behind to be uploaded twice or to fill the disk. (`downloads` and `installed`
    // are the source sandbox's marks of its install; the two share a scratch directory only here.)
    expect(await sh("ls -A", scratch)).toBe("downloads\ninstalled");
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

  it("when a file in it was overwritten after the install with its old timestamp put back", async () => {
    // What extracting a tarball over the tree does: new bytes, the archive's mtime. Only the
    // inode's change time, which nothing can set, still says it happened.
    const manager = new LocalSandbox();
    await install(manager);
    const file = join(project, "node_modules", "left-pad", "index.js");
    await sh(`touch -r ${file} ${join(directory, "stamp")}`);
    await writeFile(file, "module.exports = 'other bytes'");
    await sh(`touch -r ${join(directory, "stamp")} ${file}`);

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

describe("installDependencies says which archive, if any, describes the install", () => {
  async function installWith(hook: string | null) {
    if (hook !== null) await writeFile(join(directory, "install-hook.sh"), hook);
    const installed = await installDependencies(new LocalSandbox(), "sandbox", {
      ...options(),
      timeoutMs: 10_000,
    });
    if (!installed.ok) throw new Error(installed.error.message);
    // Whatever it says about caching, it must still have installed.
    expect(installed.value.exitCode).toBe(0);
    return installed.value.cache;
  }

  async function commit(file: string, contents: string) {
    await writeFile(join(project, file), contents);
    await sh("git add . && git commit -q -m Change");
  }

  async function archivable(): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const archive = await archiveDependencies(new LocalSandbox(), "sandbox", {
      ...options(),
      maxBytes: 1 << 20,
    });
    return archive.ok;
  }

  it("its node_modules, when nothing but the committed inputs went into it", async () => {
    expect(await installWith(null)).toBe("node_modules");
    expect(await archivable()).toBe(true);
  });

  it.each([
    ["rewrote the lockfile", 'echo "rewritten" > bun.lock'],
    ["wrote a lockfile nobody committed", 'echo "new" > bun.lockb'],
    ["edited package.json", "echo '{}' > package.json"],
  ])("none, when the install %s, and nothing is left to archive", async (_, hook) => {
    // HEAD is untouched, so a key read from what git committed cannot see this.
    expect(await installWith(hook)).toBeNull();
    expect(await archivable()).toBe(false);
  });

  it.each([
    ["postinstall", '{"dependencies":{"left-pad":"1"},"scripts":{"postinstall":"node gen.js"}}'],
    ["prepare", '{"dependencies":{"left-pad":"1"},"scripts":{"prepare":"node gen.js"}}'],
    ["workspaces", '{"dependencies":{"left-pad":"1"},"workspaces":["packages/*"]}'],
    ["a file: dependency", '{"dependencies":{"left-pad":"1","local":"file:./vendor/local"}}'],
    ["a link: dependency", '{"dependencies":{"left-pad":"1","local":"link:local"}}'],
    ["a relative path dependency", '{"devDependencies":{"local":"../local"}}'],
    ["a local override", '{"dependencies":{"left-pad":"1"},"overrides":{"x":"file:../x"}}'],
    ["a tarball by path", '{"dependencies":{"left-pad":"1","local":"vendor/local.tgz"}}'],
    [
      "a patch outside patches/",
      '{"dependencies":{"left-pad":"1"},"patchedDependencies":{"left-pad@1":"my-patches/x.patch"}}',
    ],
  ])("its packages only, when package.json declares %s", async (_, json) => {
    // A root lifecycle script can read any file and write outside node_modules; a local package
    // is a directory of source. Neither is in the key, so the tree they leave is not cached: the
    // packages are, and a reopen installs from them, which runs the scripts again.
    await commit("package.json", `${json}\n`);

    expect(await installWith(null)).toBe("packages");
  });

  it("its node_modules when every patch is under patches/, which the key hashes", async () => {
    await commit(
      "package.json",
      '{"dependencies":{"left-pad":"1"},"patchedDependencies":{"left-pad@1":"patches/x.patch"}}\n',
    );

    expect(await installWith(null)).toBe("node_modules");
  });

  it("its packages only, when the install brought in a package with an install script", async () => {
    // Such a script ran with the project as its working tree — Prisma's generates a client from
    // the project's schema — so what it wrote depends on files the key does not hold.
    const hook =
      "mkdir -p node_modules/generator && " +
      `echo '{"name":"generator","version":"1.0.0","scripts":{"postinstall":"node x"}}' ` +
      "> node_modules/generator/package.json";

    expect(await installWith(hook)).toBe("packages");
  });

  it.each([
    ["a binding.gyp", "touch node_modules/native/binding.gyp"],
    [
      "a nested package's preinstall",
      "mkdir -p node_modules/native/node_modules/inner && " +
        `echo '{"name":"inner","version":"2.0.0","scripts":{"preinstall":"x"}}' ` +
        "> node_modules/native/node_modules/inner/package.json",
    ],
  ])("its packages only, when the install brought in %s", async (_, extra) => {
    const hook = `mkdir -p node_modules/native && echo '{"name":"native","version":"1.0.0"}' > node_modules/native/package.json && ${extra}`;

    expect(await installWith(hook)).toBe("packages");
  });

  it("its node_modules when a package with an install script was already there, unchanged", async () => {
    // The template's own: installed when the image was built, on the template's tree, and not run
    // again by an install that leaves it where it is.
    await mkdir(join(project, "node_modules", "baked"), { recursive: true });
    await writeFile(
      join(project, "node_modules", "baked", "package.json"),
      '{"name":"baked","version":"1.0.0","scripts":{"postinstall":"node check.js"}}',
    );

    expect(await installWith(null)).toBe("node_modules");
  });

  it("its packages only, when the install moved a package that has an install script", async () => {
    await mkdir(join(project, "node_modules", "baked"), { recursive: true });
    await writeFile(
      join(project, "node_modules", "baked", "package.json"),
      '{"name":"baked","version":"1.0.0","scripts":{"postinstall":"node check.js"}}',
    );
    const hook = `echo '{"name":"baked","version":"2.0.0","scripts":{"postinstall":"node check.js"}}' > node_modules/baked/package.json`;

    expect(await installWith(hook)).toBe("packages");
  });

  it("none, when the tree it installed into already had an input nobody committed", async () => {
    await writeFile(join(project, ".npmrc"), "registry=https://example.invalid\n");

    expect(await installWith(null)).toBeNull();
  });

  it("none, naming the files, when the install rewrote a committed file that is not an input", async () => {
    // A root script regenerating a tracked file: the restored tree is no longer the committed one,
    // and the open has to say so rather than report a clean restore.
    await commit("generated.txt", "committed\n");
    await commit("package.json", '{"scripts":{"postinstall":"node gen.js"}}\n');
    await writeFile(join(directory, "install-hook.sh"), 'echo "regenerated" > generated.txt');

    const installed = await installDependencies(new LocalSandbox(), "sandbox", {
      ...options(),
      timeoutMs: 10_000,
    });

    expect(installed).toMatchObject({
      ok: true,
      value: { exitCode: 0, cache: null, changed: ["generated.txt"] },
    });
  });

  it("names no files when the install left every committed one alone", async () => {
    const installed = await installDependencies(new LocalSandbox(), "sandbox", {
      ...options(),
      timeoutMs: 10_000,
    });

    expect(installed).toMatchObject({ ok: true, value: { changed: [] } });
  });
});

describe("a package-cache archive's round trip", () => {
  const cache = () => join(directory, "bun-cache");

  /** What the image's own install left in Bun's cache. */
  async function image() {
    for (const entry of ["react@19", "@types/react@19"]) {
      await mkdir(join(cache(), entry), { recursive: true });
      await writeFile(join(cache(), entry, "kept"), "the image's");
    }
  }

  async function installedWithScripts(manager: LocalSandbox) {
    await writeFile(join(project, "package.json"), '{"scripts":{"postinstall":"node gen.js"}}\n');
    await sh("git add . && git commit -q -m Scripts");
    // The template's own cache: there before the install, so not the install's to archive. Its
    // `@types` scope is the one the install adds a package to.
    await image();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const installed = await installDependencies(manager, "sandbox", {
      ...options(),
      timeoutMs: 10_000,
    });
    expect(installed).toMatchObject({ ok: true, value: { exitCode: 0, cache: "packages" } });
  }

  it("carries the packages an install downloaded, so the next one needs no network", async () => {
    const manager = new LocalSandbox();
    await installedWithScripts(manager);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const archive = await archivePackageCache(manager, "sandbox", {
      ...options(),
      maxBytes: 1 << 20,
    });
    if (!archive.ok) throw new Error(archive.error.message);

    // Only what the install downloaded: nothing every sandbox already has, in its scopes or out.
    await writeFile(join(directory, "packages.tgz"), archive.value);
    expect(await sh(`tar -tzf ${join(directory, "packages.tgz")} | grep -c react || true`)).toBe(
      "0",
    );

    // A fresh sandbox: the image's cache and nothing the project downloaded.
    await rm(cache(), { recursive: true });
    await rm(join(project, "node_modules"), { recursive: true });
    await image();
    expect(
      await installDependencies(manager, "sandbox", {
        ...options(),
        offline: true,
        timeoutMs: 1e4,
      }),
    ).toMatchObject({ ok: true, value: { exitCode: 1 } });

    await stageDependencyArchive(manager, "other", archive.value, { scratch });
    expect(await extractPackageCache(manager, "other", options())).toEqual({
      ok: true,
      value: undefined,
    });
    const offline = await installDependencies(manager, "sandbox", {
      ...options(),
      offline: true,
      timeoutMs: 10_000,
    });

    expect(offline).toMatchObject({ ok: true, value: { exitCode: 0 } });
    expect(await sh("ls -A", cache())).toBe(
      ["@types", "left-pad.npm", "left-pad@1", "react@19"].join("\n"),
    );
    // A scope the sandbox already had gains the new package beside its own.
    expect(await sh("ls -A", join(cache(), "@types"))).toBe("debug@1\nreact@19");
    // An entry the sandbox already had is left as it was.
    expect(await readFile(join(cache(), "react@19", "kept"), "utf8")).toBe("the image's");
    expect(await readFile(join(cache(), "@types", "react@19", "kept"), "utf8")).toBe("the image's");
    expect(await sh(`ls -A ${scratch} | grep -c -e incoming -e '^new$' || true`)).toBe("0");
  });

  it("is refused when the install downloaded nothing", async () => {
    const manager = new LocalSandbox();
    await mkdir(join(cache(), "left-pad@1"), { recursive: true });
    await writeFile(join(cache(), "left-pad@1", "index.js"), "cached");
    await writeFile(join(cache(), "left-pad.npm"), "");
    await writeFile(join(directory, "install-hook.sh"), ":");
    // The shim always "downloads"; an install whose every package was already cached does not.
    await writeFile(
      join(shims, "bun"),
      (await readFile(join(shims, "bun"), "utf8")).replace(
        /\*\) mkdir -p "\$cache\/left-pad@1"[^;]*;;/,
        "*) ;;",
      ),
    );
    await installedWithScripts(manager);

    const archive = await archivePackageCache(manager, "sandbox", {
      ...options(),
      maxBytes: 1 << 20,
    });

    expect(archive.ok).toBe(false);
  });

  it("is refused over the bound, leaving nothing behind", async () => {
    const manager = new LocalSandbox();
    await installedWithScripts(manager);

    const archive = await archivePackageCache(manager, "sandbox", { ...options(), maxBytes: 10 });

    expect(archive.ok).toBe(false);
    expect(await sh(`ls -A ${scratch} | grep -c outgoing || true`)).toBe("0");
  });

  it("keeps an entry the cache already has, rather than moving the archive's inside it", async () => {
    const manager = new LocalSandbox();
    await mkdir(join(cache(), "react@19"), { recursive: true });
    await writeFile(join(cache(), "react@19", "kept"), "the image's");
    const packed = join(directory, "packed");
    await mkdir(join(packed, "react@19"), { recursive: true });
    await mkdir(join(packed, "left-pad@1"), { recursive: true });
    await writeFile(join(packed, "react@19", "kept"), "the archive's");
    await sh(`tar -czf ${join(directory, "packages.tgz")} react@19 left-pad@1`, packed);
    await stageDependencyArchive(
      manager,
      "sandbox",
      new Uint8Array(await readFile(join(directory, "packages.tgz"))),
      { scratch },
    );

    expect(await extractPackageCache(manager, "sandbox", options())).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await sh("ls -A", cache())).toBe("left-pad@1\nreact@19");
    expect(await sh("ls -A", join(cache(), "react@19"))).toBe("kept");
    expect(await readFile(join(cache(), "react@19", "kept"), "utf8")).toBe("the image's");
  });

  it("leaves the package cache alone when the archive is corrupt", async () => {
    const manager = new LocalSandbox();
    await mkdir(join(cache(), "react@19"), { recursive: true });
    await stageDependencyArchive(manager, "sandbox", new TextEncoder().encode("not a tarball"), {
      scratch,
    });

    const extracted = await extractPackageCache(manager, "sandbox", options());

    expect(extracted).toMatchObject({ ok: false, error: { code: "exec_failed" } });
    expect(await sh("ls -A", cache())).toBe("react@19");
  });
});

it("installDependencies reports no key when the install failed", async () => {
  await writeFile(join(shims, "bun"), '#!/bin/sh\n[ "$1" = "--revision" ] && echo r\nexit 3\n');

  const installed = await installDependencies(new LocalSandbox(), "sandbox", {
    ...options(),
    timeoutMs: 10_000,
  });

  expect(installed).toMatchObject({ ok: true, value: { exitCode: 3, cache: null } });
  // No record of a successful install, so nothing can be archived from this tree.
  await expect(readFile(join(scratch, "installed"))).rejects.toThrow();
});

it("is collected with a symlink target we can read", async () => {
  // Guards the helper above: `treeOf` must see links as links, or the round trip proves nothing.
  await mkdir(join(project, "node_modules"));
  await symlink("target", join(project, "node_modules", "link"));
  expect(await treeOf(project)).toBe("node_modules/link -> target");
});
