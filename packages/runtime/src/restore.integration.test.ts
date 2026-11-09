/**
 * The full round trip a project's life depends on: build something, put it away, open it again.
 *
 * The unit tests pin the order and the fallbacks, but they cannot say whether what comes back
 * is the project that went in — only real git in a real sandbox can. This is the assertion
 * `docs/PLAN.md` §4 asks for by name: **byte-identical on tracked files**, which here means the
 * blob shas git itself records for every tracked path, compared before and after.
 *
 * Object storage is faked deliberately. What is under test is the bundle and the sandbox, not
 * R2 — and a bucket would make this neither free nor deterministic.
 *
 * The project adds a real dependency before it is put away, so the reopens take every path the
 * dependency cache has: the first misses, installs and stores an archive; the second extracts it
 * and must then build; a corrupt archive must fall back to installing. Each open's duration is
 * printed, since none of it can be measured on a fake.
 */

import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { encodeDependencyArchive } from "@nap/sandbox/dependency-cache";
import { E2BSandboxManager } from "@nap/sandbox/e2b-sandbox-manager";
import { commitAll, currentSha } from "@nap/sandbox/git";
import { NAP_TEMPLATE, TEMPLATE_FILES, TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { afterAll, beforeAll, expect, it } from "vitest";
import { dependenciesKey, openProject } from "./restore.ts";
import { tearDownProject } from "./teardown.ts";

if (process.env.E2B_API_KEY === undefined || process.env.E2B_API_KEY === "") {
  throw new Error(
    "E2B_API_KEY is not set, so the snapshot round trip cannot verify anything. " +
      "Put it in apps/api/.env or export it, then re-run `bun run test:integration`.",
  );
}

const PROJECT = "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f607182";
const FILE = "src/restored.ts";
const CONTENTS = "export const survived = true;\n";
/** Small, dependency-free and pinned, so the install it costs is the install and nothing else. */
const ADDED = "tiny-invariant@1.3.3";

const manager = new E2BSandboxManager({ template: NAP_TEMPLATE });
const objects = new InMemoryObjectStore();
const snapshots = new InMemorySnapshotStore();

/** Every sandbox this file created, so a failure part-way through still cleans up. */
const created: string[] = [];

/** The repository as git sees it: one line per tracked path, carrying its blob sha. */
let treeBefore: string;
let shaBefore: string;
let restoredSandboxId: string;
/** The second reopen, whose dependencies came from the archive the first one stored. */
let cachedSandboxId: string;

async function sh(sandboxId: string, command: string): Promise<string> {
  const result = await manager.exec(sandboxId, `cd ${TEMPLATE_WORKDIR} && ${command}`);
  if (!result.ok) throw new Error(`exec failed: ${result.error.message}`);
  if (result.value.exitCode !== 0) {
    throw new Error(
      `command failed (${result.value.exitCode}): ${command}\n${result.value.stderr}`,
    );
  }
  return result.value.stdout;
}

async function create(): Promise<string> {
  const sandbox = await manager.create(PROJECT);
  if (!sandbox.ok) throw new Error(`could not create a sandbox: ${sandbox.error.message}`);
  created.push(sandbox.value.id);
  return sandbox.value.id;
}

beforeAll(async () => {
  const sandboxId = await create();

  await manager.writeFile(sandboxId, `${TEMPLATE_WORKDIR}/${FILE}`, CONTENTS);
  // Moves package.json and the lockfile, so the image's baked `node_modules` is no longer the
  // project's and a reopen has to install or extract.
  await sh(sandboxId, `bun add ${ADDED}`);

  const committed = await commitAll(manager, sandboxId, "Add a file worth restoring");
  if (!committed.ok) throw new Error(`could not commit: ${committed.error.message}`);

  const head = await currentSha(manager, sandboxId);
  if (!head.ok) throw new Error(`could not read HEAD: ${head.error.message}`);
  shaBefore = head.value;
  treeBefore = await sh(sandboxId, "git ls-tree -r HEAD");

  const torn = await tearDownProject({
    sandbox: manager,
    objects,
    snapshots,
    projectId: PROJECT,
    sandboxId,
  });
  if (!torn.ok) throw new Error(`could not tear the project down: ${torn.error.message}`);
  expect(torn.value.destroyed).toBe(true);

  // First reopen: nothing stored yet, so it installs, then stores the archive afterwards.
  let started = performance.now();
  const opened = await openProject({ sandbox: manager, objects, snapshots, projectId: PROJECT });
  if (!opened.ok) throw new Error(`could not open the project: ${opened.error.message}`);
  console.log(`reopen that installed: ${Math.round(performance.now() - started)}ms`);
  created.push(opened.value.sandboxId);
  restoredSandboxId = opened.value.sandboxId;

  expect(opened.value).toMatchObject({
    restored: true,
    warning: null,
    installed: true,
    cachedDependencies: false,
  });
  expect(await opened.value.dependencyCacheWrite).toBe(true);
  const archive = await objects.get(dependenciesKey(PROJECT));
  if (!archive.ok) throw new Error("the first reopen stored no dependency archive");
  console.log(`dependency archive: ${archive.value.length} bytes`);

  // Second reopen of the same snapshot: the archive matches, so nothing installs.
  started = performance.now();
  const cached = await openProject({ sandbox: manager, objects, snapshots, projectId: PROJECT });
  if (!cached.ok) throw new Error(`could not reopen the project: ${cached.error.message}`);
  console.log(`reopen from the archive: ${Math.round(performance.now() - started)}ms`);
  created.push(cached.value.sandboxId);
  cachedSandboxId = cached.value.sandboxId;

  expect(cached.value).toMatchObject({
    restored: true,
    warning: null,
    installed: false,
    cachedDependencies: true,
  });
}, 600_000);

afterAll(async () => {
  for (const sandboxId of created) await manager.destroy(sandboxId);
});

it("restores the exact commit that was put away", async () => {
  const head = await currentSha(manager, restoredSandboxId);

  expect(head).toEqual({ ok: true, value: shaBefore });
});

it("restores every tracked file byte for byte", async () => {
  // Blob shas, so this compares contents rather than names — a file restored with different
  // bytes gets a different sha and this fails, which a listing of paths would not catch.
  const treeAfter = await sh(restoredSandboxId, "git ls-tree -r HEAD");

  expect(treeAfter).toBe(treeBefore);
  expect(treeAfter).toContain(FILE);
});

it("puts the working tree back, not just the history", async () => {
  const contents = await manager.readFile(restoredSandboxId, `${TEMPLATE_WORKDIR}/${FILE}`);

  expect(contents).toEqual({ ok: true, value: CONTENTS });
});

it("keeps the baked dependencies rather than reinstalling from nothing", async () => {
  // `git clean -fdx` during the restore would delete them, turning a seconds-long open into
  // a full install. The install that did run had them to work from.
  const result = await manager.exec(
    restoredSandboxId,
    `cd ${TEMPLATE_WORKDIR} && test -d node_modules/react && test -d node_modules/vite`,
  );

  expect(result).toMatchObject({ ok: true, value: { exitCode: 0 } });
});

it("restores the same commit, files and clean tree when the dependencies come from the archive", async () => {
  expect(await currentSha(manager, cachedSandboxId)).toEqual({ ok: true, value: shaBefore });
  expect(await sh(cachedSandboxId, "git ls-tree -r HEAD")).toBe(treeBefore);
  // Nothing the extraction did is visible to git: no untracked or modified file.
  expect(await sh(cachedSandboxId, "git status --porcelain --untracked-files=all")).toBe("");
});

it("hands back dependencies that work: the added one resolves, and the project builds", async () => {
  await sh(cachedSandboxId, `node -e "require.resolve('tiny-invariant')"`);
  await sh(cachedSandboxId, "test -d node_modules/react && test -d node_modules/.bin");
  await sh(cachedSandboxId, "bun run build");
});

it("installs rather than breaking the project when the stored archive will not extract", async () => {
  const stored = await objects.get(dependenciesKey(PROJECT));
  if (!stored.ok) throw new Error("expected the archive the first reopen stored");
  // The right key, so the restore tries it, over bytes that are not a tarball.
  const header = new TextDecoder().decode(stored.value.subarray(0, 200)).split("\n")[1] ?? "";
  const key = (JSON.parse(header) as { key: string }).key;
  await objects.put(
    dependenciesKey(PROJECT),
    encodeDependencyArchive(key, new TextEncoder().encode("not a tarball")),
  );

  const opened = await openProject({ sandbox: manager, objects, snapshots, projectId: PROJECT });
  if (!opened.ok) throw new Error(`could not open the project: ${opened.error.message}`);
  created.push(opened.value.sandboxId);

  expect(opened.value).toMatchObject({
    restored: true,
    warning: null,
    installed: true,
    cachedDependencies: false,
  });
  await sh(opened.value.sandboxId, `node -e "require.resolve('tiny-invariant')"`);
  // The install replaces the corrupt archive with a good one.
  expect(await opened.value.dependencyCacheWrite).toBe(true);
}, 600_000);

it("falls back to a fresh template when the stored bundle is not a bundle", async () => {
  const corrupt = new InMemoryObjectStore();
  const rows = new InMemorySnapshotStore();
  const key = "projects/corrupt/1-deadbeef.bundle";
  await corrupt.put(key, new TextEncoder().encode("this is not a git bundle"));
  await rows.record({ projectId: PROJECT, key, gitSha: "deadbeef" });

  const opened = await openProject({
    sandbox: manager,
    objects: corrupt,
    snapshots: rows,
    projectId: PROJECT,
  });

  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  created.push(opened.value.sandboxId);

  // A project the user can still work in, and an honest sentence about what happened to the
  // one they left. The alternative is an error page in place of an app.
  expect(opened.value.restored).toBe(false);
  expect(opened.value.warning).toMatch(/snapshot/i);

  const listing = await sh(opened.value.sandboxId, "git ls-files");
  for (const file of TEMPLATE_FILES) expect(listing).toContain(file);
});
