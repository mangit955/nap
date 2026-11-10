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
 * **A key only describes an install its inputs decided.** One that rewrote its own lockfile, or
 * ran a lifecycle script — which can read any file in the project and write anywhere — produced
 * something those inputs do not name. `installDependencies` refuses to call such an install
 * cacheable, so it is never stored, and that project installs on every reopen as it always did.
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

/**
 * A Node script deciding whether an install may be cached, run before it (`scan`) and after it
 * (`check <scan's output>`). Node rather than shell because it parses `package.json`.
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
 * Version 2: version 1 archives were stored before an install had to show that its inputs alone
 * decided it, so some of them describe trees their key does not, and none can be told apart.
 */
const PREFIX = "# nap dependencies v2\n";
const Header = z.object({ key: z.string().regex(KEY) });

/** The archive as it is stored: a line naming its key, then the gzipped tarball. */
export function encodeDependencyArchive(key: string, archive: Uint8Array): Uint8Array {
  return Buffer.concat([Buffer.from(`${PREFIX}${JSON.stringify({ key })}\n`), archive]);
}

/** The key and the archive, or null when the bytes are not something this wrote. */
export function decodeDependencyArchive(
  bytes: Uint8Array,
): { key: string; archive: Uint8Array } | null {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, PREFIX.length).toString() !== PREFIX) return null;
  const end = buffer.indexOf(10, PREFIX.length);
  if (end < 0 || end - PREFIX.length > 1024) return null;
  try {
    const header = Header.safeParse(JSON.parse(buffer.subarray(PREFIX.length, end).toString()));
    const archive = buffer.subarray(end + 1);
    if (!header.success || archive.length === 0) return null;
    return { key: header.data.key, archive: new Uint8Array(archive) };
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

/** What an install prints last when its result may be cached. */
export const DEPENDENCY_CACHEABLE_LINE = "nap-dependencies-cacheable";

/**
 * Installs the project's dependencies and says whether the result may be cached — one command.
 *
 * Cacheable only when the inputs were exactly the committed ones before the install and still are
 * after it, and `ELIGIBILITY` finds nothing else the install could have read. Then, and only then,
 * it writes the record `archiveDependencies` requires: the packages it left, at the time it left
 * them. A key read from HEAD cannot see an install that rewrote its lockfile, because HEAD did not
 * move; the working tree's status can.
 *
 * Whether it is cacheable never changes whether it installed: the check that decides is outside
 * the install's own `&&` chain, so the exit code is the install's, as it was before.
 */
export async function installDependencies(
  manager: SandboxManager,
  sandboxId: string,
  options: DependencyOptions & { signal?: AbortSignal | undefined; timeoutMs: number },
): Promise<Result<{ exitCode: number; cacheable: boolean; stderr: string }, SandboxError>> {
  const p = paths(options);
  const eligibility = `node -e ${shellQuote(ELIGIBILITY)}`;
  const result = await manager.exec(
    sandboxId,
    `cd ${p.cwd} && mkdir -p ${p.scratch} && rm -f ${p.installed} ${p.scripted} && ` +
      `{ test -z "$(${INPUTS_STATUS})" && ${eligibility} scan > ${p.scripted} || rm -f ${p.scripted}; } && ` +
      "bun install && " +
      `{ { test -f ${p.scripted} && test -z "$(${INPUTS_STATUS})" && ` +
      `${eligibility} check ${p.scripted} && { ${PACKAGES} > ${p.installed} || true; } && ` +
      `echo ${DEPENDENCY_CACHEABLE_LINE}; } || true; rm -f ${p.scripted}; }`,
    undefined,
    { signal: options.signal, stopOnGiveUp: true, timeoutMs: options.timeoutMs },
  );
  if (!result.ok) return result;
  const { exitCode, stdout, stderr } = result.value;
  const cacheable =
    exitCode === 0 && stdout.trimEnd().split("\n").at(-1)?.trim() === DEPENDENCY_CACHEABLE_LINE;
  return { ok: true, value: { exitCode, cacheable, stderr } };
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

function failed(message: string): Result<never, SandboxError> {
  return { ok: false, error: { code: "exec_failed", message } };
}
