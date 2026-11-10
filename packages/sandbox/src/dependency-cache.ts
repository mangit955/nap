/**
 * A project's installed dependencies as one archive, so a reopened project gets them back without
 * running `bun install`. See `docs/adr/0032-a-reopen-does-not-reinstall.md`.
 *
 * The template bakes a `node_modules` into the image, which is right for exactly the dependencies
 * the template declares. A project that added one used to reinstall on every reopen. Now the first
 * reopen that has to install packs the tree the install left, the runtime stores it beside the
 * project's snapshot, and later reopens extract it instead.
 *
 * **The whole design is the key, because a cache that can be wrong is worse than none.** It is
 * computed in the sandbox, from what git has committed for every file that decides what an install
 * produces, together with the toolchain that ran it, and it is written into the stored object.
 * An archive is only ever extracted when its key matches the restored tree exactly. Anything else
 * (a stale key, an envelope that does not parse, a tarball that does not extract) is a miss, and a
 * miss installs, which is what happened before this existed.
 *
 * **What is archived depends on what decided the install.** One its committed inputs alone
 * decided is archived as the `node_modules` it left, and a reopen extracts that and installs
 * nothing. One that ran a lifecycle script, or read a local package, depends on files no key can
 * name — a script can read anything in the project and write anywhere — so its tree is never
 * archived. Bun's package cache is, instead: what the install downloaded, which depends only on
 * the lockfile. A reopen restores it and runs `bun install --offline`, which runs the scripts again
 * against the tree being opened, exactly as any install would, without the network. An install
 * that rewrote its own inputs is archived as neither.
 *
 * Plain functions over a `SandboxManager`, like `git.ts`: the commands are a convention of how
 * projects are laid out, not something a sandbox is.
 */

import { createHash } from "node:crypto";
import type { SandboxError, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { Result, VoidResult } from "@nap/shared/result";
import { shellQuote } from "@nap/shared/shell";
import { z } from "zod";
import { TEMPLATE_WORKDIR } from "./template.ts";

/**
 * Every committed file that can change what `bun install` writes into `node_modules`.
 *
 * Both lockfile names, because which one Bun writes depends on its version. `package.json` as well
 * as the lockfile, because the lockfile does not record everything an install acts on, such as the
 * root package's own `postinstall`. `patches` is a directory: `ls-tree` names it by the hash of its
 * whole contents. A path that does not exist is left out of the listing, so adding one changes it.
 */
export const DEPENDENCY_INPUTS = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "bunfig.toml",
  ".npmrc",
  "patches",
] as const;

/**
 * Prints one line: a sha256 of the committed install inputs at HEAD and of the toolchain.
 *
 * Run as `restoreBundle`'s probe, so the template's key and the project's are read inside the
 * restore's own round trip, on the tree each one actually is. That is why this is not a constant
 * computed when the image is built: the key read in the sandbox cannot disagree with the image it
 * is read from.
 *
 * It cannot fail: a missing tool's complaint is hashed like anything else, and the pipeline's
 * status is `cut`'s. A missing `sha256sum` prints nothing, which `readDependencyKey` refuses, so
 * the worst case is the install this replaces, never a false match.
 */
export const DEPENDENCY_KEY_PROBE =
  `{ git ls-tree HEAD -- ${DEPENDENCY_INPUTS.join(" ")}; bun --revision; node --version; uname -m; }` +
  " 2>&1 | sha256sum | cut -c1-64";

/**
 * Directories under `node_modules` that tools use as caches rather than packages: Vite's optimized
 * dependencies and config bundle, and the conventional `.cache` and `.tmp`.
 *
 * Left out of an archive, ignored when deciding whether the tree moved since the install, and
 * carried over from the tree an extraction replaces. A running dev server writes `.vite` whenever
 * a page asks for a dependency it has not optimized, and that must neither make every archive be
 * refused nor be thrown away under the server's feet: an install leaves these alone too.
 */
export const DEPENDENCY_CACHE_DIRECTORIES = [".vite", ".vite-temp", ".cache", ".tmp"] as const;

/**
 * Whether a working tree's install inputs are exactly what HEAD committed: prints nothing if so.
 * Ignored and untracked inputs count, since an install reads them as readily as committed ones.
 */
const INPUTS_STATUS = `git status --porcelain --ignored --untracked-files=all -- ${DEPENDENCY_INPUTS.join(" ")} 2>&1`;

/** Every committed file the working tree no longer matches, one `git status` line each. */
const TRACKED_STATUS = "git status --porcelain --untracked-files=no";

/**
 * A Node script deciding whether the tree an install left may be cached, run before it (`scan`)
 * and after it (`check <scan's output>`). Node rather than shell because it parses `package.json`.
 *
 * `scan` prints every package under `node_modules` with an install-time script of its own, or a
 * `binding.gyp` that makes one implicit. `check` exits non-zero when the install brought in one that
 * was not there before — such a script ran with the project as its working tree, and Prisma's, for
 * one, generates code from the project's schema — or when the root `package.json` has lifecycle
 * scripts, workspaces, local packages or a patch outside `patches/`, all of which read inputs the
 * key does not hold. A tarball named by path is local too, even though the lockfile pins its hash.
 *
 * Packages that were already there at the same version are fine: they are the template's, and an
 * install that leaves them where they are does not run their scripts again.
 */
const ELIGIBILITY = String.raw`
const fs = require("node:fs"), path = require("node:path");
const [mode, before] = process.argv.slice(1);
const caches = new Set(${JSON.stringify(DEPENDENCY_CACHE_DIRECTORIES)});
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const declares = (json, names) => names.some((name) => typeof json?.scripts?.[name] === "string");
const scripted = [];
const walk = (dir) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  if (entries.some((entry) => entry.name === "package.json")) {
    const json = read(path.join(dir, "package.json"));
    if (declares(json, ["preinstall", "install", "postinstall"]) || fs.existsSync(path.join(dir, "binding.gyp"))) {
      scripted.push(dir + " " + json?.name + "@" + json?.version);
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !(dir === "node_modules" && caches.has(entry.name))) walk(path.join(dir, entry.name));
  }
};
walk("node_modules");
if (mode === "scan") { console.log(scripted.sort().join("\n")); process.exit(0); }
const known = new Set(fs.readFileSync(before, "utf8").split("\n"));
const root = read("package.json");
const local = /^(file|link|workspace|portal|git\+file):|^\.{0,2}\/|^~\/|\.(tgz|tar|tar\.gz)$/;
const specs = (value) => typeof value === "string" ? [value]
  : value && typeof value === "object" ? Object.values(value).flatMap(specs) : [];
const fits = root !== null
  && !declares(root, ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare"])
  && root.workspaces === undefined
  && specs(root.patchedDependencies).every((patch) => patch.startsWith("patches/"))
  && !["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions"]
    .some((field) => specs(root[field]).some((spec) => local.test(spec)))
  && scripted.every((line) => known.has(line));
process.exit(fits ? 0 : 1);
`;

/** Where the scripts below keep their files. Outside the project, so `git add --all` cannot see them. */
export const DEPENDENCY_SCRATCH = "/home/user/.nap/dependencies";

export type DependencyOptions = {
  /** The project. Defaults to the template's. */
  cwd?: string | undefined;
  /** Defaults to `DEPENDENCY_SCRATCH`. Must be on the same filesystem as the project. */
  scratch?: string | undefined;
};

const KEY = /^[0-9a-f]{64}$/;

/** The key a probe printed, or null for anything that is not exactly one. */
export function readDependencyKey(line: string): string | null {
  const trimmed = line.trim();
  return KEY.test(trimmed) ? trimmed : null;
}

/**
 * The key an archive is stored under: what the install started from, and what it installed.
 *
 * The template's side is in it because a restore installs on top of the baked dependencies, with
 * the image's toolchain. A rebuilt template therefore misses on every archive written before it,
 * once each, rather than handing a project a tree installed by something else.
 */
export function dependencyCacheKey(template: string, project: string): string {
  return createHash("sha256").update(`${template}\n${project}\n`).digest("hex");
}

/**
 * Version 3. Version 1 archives were stored before an install had to show that its inputs alone
 * decided it, so some describe trees their key does not; version 2 ones do not say their kind.
 */
const PREFIX = "# nap dependencies v3\n";
const Header = z.object({
  key: z.string().regex(KEY),
  /**
   * `node_modules`: the tree an install left, extracted in place of installing. `packages`: Bun's
   * package cache, which a reopen restores and then installs from offline.
   */
  kind: z.enum(["node_modules", "packages"]),
});

export type DependencyArchiveKind = z.infer<typeof Header>["kind"];

/** The archive as it is stored: a line naming its key and kind, then the gzipped tarball. */
export function encodeDependencyArchive(
  key: string,
  kind: DependencyArchiveKind,
  archive: Uint8Array,
): Uint8Array {
  return Buffer.concat([Buffer.from(`${PREFIX}${JSON.stringify({ key, kind })}\n`), archive]);
}

/** The key, kind and archive, or null when the bytes are not something this wrote. */
export function decodeDependencyArchive(
  bytes: Uint8Array,
): { key: string; kind: DependencyArchiveKind; archive: Uint8Array } | null {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, PREFIX.length).toString() !== PREFIX) return null;
  const end = buffer.indexOf(10, PREFIX.length);
  if (end < 0 || end - PREFIX.length > 1024) return null;
  try {
    const header = Header.safeParse(JSON.parse(buffer.subarray(PREFIX.length, end).toString()));
    const archive = buffer.subarray(end + 1);
    if (!header.success || archive.length === 0) return null;
    return { key: header.data.key, kind: header.data.kind, archive: new Uint8Array(archive) };
  } catch {
    return null;
  }
}

function paths(options: DependencyOptions | undefined) {
  const scratch = options?.scratch ?? DEPENDENCY_SCRATCH;
  return {
    cwd: shellQuote(options?.cwd ?? TEMPLATE_WORKDIR),
    scratch: shellQuote(scratch),
    incoming: `${scratch}/incoming.tar.gz`,
    outgoing: shellQuote(`${scratch}/outgoing.tar.gz`),
    /** Written after a cacheable install succeeds: its time and the packages it left. */
    installed: shellQuote(`${scratch}/installed`),
    /** The packages with install scripts that were there before the install. */
    scripted: shellQuote(`${scratch}/scripted`),
    /** Touched just before an install: what it downloaded into Bun's cache is newer. */
    downloads: shellQuote(`${scratch}/downloads`),
    fresh: shellQuote(`${scratch}/new`),
    old: shellQuote(`${scratch}/old`),
  };
}

/** The top-level entries of `node_modules`, caches left out, one per line. */
const PACKAGES =
  "ls -A node_modules 2>/dev/null | grep -v -x " +
  DEPENDENCY_CACHE_DIRECTORIES.map((name) => `-e ${name}`).join(" ");

/**
 * Every path under `node_modules` changed after `marker`, caches left out.
 *
 * By the inode's change time, not its modification time: a tarball extracted over the tree, or a
 * `cp -p`, writes new bytes under an old mtime, but nothing can set a ctime back.
 */
function changedSince(marker: string): string {
  const caches = DEPENDENCY_CACHE_DIRECTORIES.map((name) => `-path node_modules/${name}`).join(
    " -o ",
  );
  return `find node_modules -mindepth 1 \\( ${caches} \\) -prune -o -cnewer ${marker} -print`;
}

/** Starts the line an install prints naming the archive that describes it. */
export const DEPENDENCY_CACHE_LINE = "nap-dependencies-cache";
/** Starts each line an install prints naming a committed file it changed. */
export const DEPENDENCY_CHANGED_LINE = "nap-dependencies-changed";

export type InstalledDependencies = {
  exitCode: number;
  /** The archive that describes this install, or null when none does. Null unless it succeeded. */
  cache: DependencyArchiveKind | null;
  /** Committed files the install left different from HEAD, as paths. Empty unless it succeeded. */
  changed: string[];
  stderr: string;
};

/**
 * Installs the project's dependencies, says which archive describes the result, and names any
 * committed file it changed — one command.
 *
 * Before the install, its inputs must be exactly the committed ones and every tracked file
 * unchanged; after it, the same. Then the tree it left is described by its inputs when
 * `ELIGIBILITY` also finds nothing else it could have read (`node_modules`, and the record
 * `archiveDependencies` requires is written), and otherwise only what it downloaded is (`packages`).
 * A key read from HEAD cannot see an install that rewrote its lockfile, because HEAD did not
 * move; the working tree's status can.
 *
 * `offline` installs from Bun's package cache alone, as restored by `extractPackageCache`, with the
 * lockfile frozen so that nothing can be resolved differently from how it was online.
 *
 * Either way files are copied out of the cache, never linked. On Linux Bun hardlinks by default,
 * and a lifecycle script that edits a dependency's file in place would then edit the cache's copy
 * too: `archivePackageCache` would store the edit, and the next reopen would apply the script again
 * on top of it, producing a tree no fresh install would.
 *
 * None of this changes whether it installed: the checks are outside the install's own `&&` chain,
 * so the exit code is the install's, as it was before.
 */
export async function installDependencies(
  manager: SandboxManager,
  sandboxId: string,
  options: DependencyOptions & {
    offline?: boolean | undefined;
    signal?: AbortSignal | undefined;
    timeoutMs: number;
  },
): Promise<Result<InstalledDependencies, SandboxError>> {
  const p = paths(options);
  const eligibility = `node -e ${shellQuote(ELIGIBILITY)}`;
  const clean = `test -z "$(${INPUTS_STATUS})" && test -z "$(${TRACKED_STATUS} 2>&1)"`;
  const install =
    (options.offline === true ? "bun install --offline --frozen-lockfile" : "bun install") +
    " --backend=copyfile";
  const result = await manager.exec(
    sandboxId,
    `cd ${p.cwd} && mkdir -p ${p.scratch} && rm -f ${p.installed} ${p.scripted} ${p.downloads} && ` +
      `{ ${clean} && ${eligibility} scan > ${p.scripted} && touch ${p.downloads} || rm -f ${p.scripted}; } && ` +
      `${install} && ` +
      `{ ${TRACKED_STATUS} | sed 's/^/${DEPENDENCY_CHANGED_LINE} /'; ` +
      `{ test -f ${p.scripted} && ${clean} && ` +
      `{ ${eligibility} check ${p.scripted} && { ${PACKAGES} > ${p.installed} || true; } && ` +
      `echo '${DEPENDENCY_CACHE_LINE} node_modules' || echo '${DEPENDENCY_CACHE_LINE} packages'; }; } || true; ` +
      `rm -f ${p.scripted}; }`,
    undefined,
    { signal: options.signal, stopOnGiveUp: true, timeoutMs: options.timeoutMs },
  );
  if (!result.ok) return result;
  const { exitCode, stdout, stderr } = result.value;
  if (exitCode !== 0) return { ok: true, value: { exitCode, cache: null, changed: [], stderr } };

  const lines = stdout.split("\n");
  const kind = lines
    .filter((line) => line.startsWith(`${DEPENDENCY_CACHE_LINE} `))
    .at(-1)
    ?.slice(DEPENDENCY_CACHE_LINE.length + 1)
    .trim();
  const changed = lines
    .filter((line) => line.startsWith(`${DEPENDENCY_CHANGED_LINE} `))
    // `git status --porcelain` is two status letters and a space, then the path.
    .map((line) => line.slice(DEPENDENCY_CHANGED_LINE.length + 1 + 3))
    // Quoted by git when it holds a space or anything unusual; the quotes are not the name.
    .map((path) =>
      path.length > 1 && path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path,
    )
    .filter((path) => path !== "");
  const cache = kind === "node_modules" || kind === "packages" ? kind : null;
  return { ok: true, value: { exitCode, cache, changed, stderr } };
}

/** Puts a stored archive where `extractDependencies` reads it from. Bytes, both ways. */
export async function stageDependencyArchive(
  manager: SandboxManager,
  sandboxId: string,
  archive: Uint8Array,
  options?: DependencyOptions,
): Promise<VoidResult<SandboxError>> {
  return await manager.writeFileBytes(sandboxId, paths(options).incoming, archive);
}

/**
 * Replaces `node_modules` with the staged archive's — one command.
 *
 * Extracted beside the project first and swapped in only once that worked, so a corrupt or
 * truncated archive leaves the existing dependencies exactly as they were. The caches the old tree
 * held are moved into the new one, as an install would have left them.
 */
export async function extractDependencies(
  manager: SandboxManager,
  sandboxId: string,
  options?: DependencyOptions,
): Promise<VoidResult<SandboxError>> {
  const p = paths(options);
  const incoming = shellQuote(p.incoming);
  const carried = DEPENDENCY_CACHE_DIRECTORIES.join(" ");
  const result = await manager.exec(
    sandboxId,
    `cd ${p.cwd} && rm -rf ${p.fresh} ${p.old} && mkdir -p ${p.fresh} && ` +
      `tar -xzf ${incoming} -C ${p.fresh} && test -d ${p.fresh}/node_modules && ` +
      `{ test ! -e node_modules || mv node_modules ${p.old}; } && ` +
      `mv ${p.fresh}/node_modules node_modules && ` +
      `for d in ${carried}; do if [ -e ${p.old}/$d ]; then ` +
      `rm -rf node_modules/$d && mv ${p.old}/$d node_modules/$d; fi; done && ` +
      `rm -rf ${p.fresh} ${p.old} ${incoming}`,
  );
  if (!result.ok) return result;
  if (result.value.exitCode !== 0) {
    return failed(`could not extract the dependency archive: ${result.value.stderr}`);
  }
  return { ok: true, value: undefined };
}

/**
 * Packs `node_modules` as the last install left it, or refuses — one command, then a read.
 *
 * Runs while the project is in use, so the tree may have moved since the install. It is refused
 * when it has: an entry under it newer than the install's record, or a different set of packages.
 * The check runs after the archive is written, so a change made while it was being written is
 * caught too. Refused, the cache is simply not written, and the next reopen installs.
 *
 * `maxBytes` bounds what is read back into this process's memory, and what a reopen downloads.
 */
export async function archiveDependencies(
  manager: SandboxManager,
  sandboxId: string,
  options: DependencyOptions & { maxBytes: number },
): Promise<Result<Uint8Array, SandboxError>> {
  const p = paths(options);
  const archived = await manager.exec(
    sandboxId,
    `cd ${p.cwd} && test -f ${p.installed} && rm -f ${p.outgoing} && ` +
      `${PACKAGES} | sed 's|^|node_modules/|' | tar -czf ${p.outgoing} -T - && ` +
      `${PACKAGES} | cmp -s - ${p.installed} && ` +
      `test -z "$(${changedSince(p.installed)} | head -n 1)" && wc -c < ${p.outgoing}`,
  );
  if (!archived.ok) return archived;

  const size = Number(archived.value.stdout.trim());
  let result: Result<Uint8Array, SandboxError>;
  if (archived.value.exitCode !== 0 || !Number.isSafeInteger(size)) {
    result = failed("the dependencies changed after they were installed, or could not be packed");
  } else if (size > options.maxBytes) {
    result = failed(`the dependency archive is ${size} bytes, over the ${options.maxBytes} kept`);
  } else {
    result = await manager.readFileBytes(
      sandboxId,
      `${options.scratch ?? DEPENDENCY_SCRATCH}/outgoing.tar.gz`,
    );
  }

  // Spelled `rm -f --` so that it is a different command from the archive's own `rm -f`, for the
  // fakes that answer commands by pattern.
  await manager.exec(sandboxId, `rm -f -- ${p.outgoing}`);
  return result;
}

/**
 * Packs what the last install downloaded into Bun's package cache, or refuses — one command, then
 * a read.
 *
 * "Downloaded" is every entry of the cache newer than the mark the install left just before it ran:
 * package directories and their manifests at the top level, and inside each `@scope` directory the
 * scoped packages, since Bun keeps those a level down. A scope directory is never archived whole:
 * the image's cache already has scopes such as `@types`, so the package the install added must be
 * found inside it, and the image's own packages there left out, since every sandbox has them. Nothing here has to be checked against the tree as
 * `archiveDependencies` does, because nothing is extracted from it as a tree: an offline install
 * reads what it needs from it by name and version, and fails when something is missing.
 */
export async function archivePackageCache(
  manager: SandboxManager,
  sandboxId: string,
  options: DependencyOptions & { maxBytes: number },
): Promise<Result<Uint8Array, SandboxError>> {
  const p = paths(options);
  const archived = await manager.exec(
    sandboxId,
    `cd ${p.cwd} && test -f ${p.downloads} && cache=$(bun pm cache) && rm -f ${p.outgoing} && ` +
      `cd "$cache" && entries=$({ find . -mindepth 1 -maxdepth 1 ! -name '@*' -cnewer ${p.downloads}; ` +
      `find . -mindepth 2 -maxdepth 2 -path './@*/*' -cnewer ${p.downloads}; }) && ` +
      `test -n "$entries" && printf '%s\\n' "$entries" | tar -cz -f ${p.outgoing} -T - && ` +
      `wc -c < ${p.outgoing}`,
  );
  if (!archived.ok) return archived;

  const size = Number(archived.value.stdout.trim());
  let result: Result<Uint8Array, SandboxError>;
  if (archived.value.exitCode !== 0 || !Number.isSafeInteger(size)) {
    result = failed("the install downloaded nothing, or its packages could not be packed");
  } else if (size > options.maxBytes) {
    result = failed(`the package archive is ${size} bytes, over the ${options.maxBytes} kept`);
  } else {
    result = await manager.readFileBytes(
      sandboxId,
      `${options.scratch ?? DEPENDENCY_SCRATCH}/outgoing.tar.gz`,
    );
  }

  await manager.exec(sandboxId, `rm -f -- ${p.outgoing}`);
  return result;
}

/**
 * Adds the staged package archive's entries to Bun's package cache — one command.
 *
 * Extracted beside the cache first and moved in only once that worked, so a corrupt archive adds
 * nothing. An entry the cache already holds is kept as it is: it came with the image. A scope
 * directory is merged, not skipped, so a package added to a scope the image has still arrives.
 */
export async function extractPackageCache(
  manager: SandboxManager,
  sandboxId: string,
  options?: DependencyOptions,
): Promise<VoidResult<SandboxError>> {
  const p = paths(options);
  const incoming = shellQuote(p.incoming);
  const result = await manager.exec(
    sandboxId,
    `cd ${p.cwd} && cache=$(bun pm cache) && rm -rf ${p.fresh} && mkdir -p ${p.fresh} "$cache" && ` +
      `tar -xz -f ${incoming} -C ${p.fresh} && test -n "$(ls -A ${p.fresh})" && ` +
      `for entry in $(ls -A ${p.fresh}); do ` +
      `if [ -d ${p.fresh}/"$entry" ] && [ "\${entry#@}" != "$entry" ]; then ` +
      `mkdir -p "$cache/$entry" || exit 1; for scoped in $(ls -A ${p.fresh}/"$entry"); do ` +
      `test -e "$cache/$entry/$scoped" || mv ${p.fresh}/"$entry/$scoped" "$cache/$entry/$scoped" || exit 1; done; ` +
      `else test -e "$cache/$entry" || mv ${p.fresh}/"$entry" "$cache/$entry" || exit 1; fi; done && ` +
      `rm -rf ${p.fresh} ${incoming}`,
  );
  if (!result.ok) return result;
  if (result.value.exitCode !== 0) {
    return failed(`could not extract the package archive: ${result.value.stderr}`);
  }
  return { ok: true, value: undefined };
}

function failed(message: string): Result<never, SandboxError> {
  return { ok: false, error: { code: "exec_failed", message } };
}
