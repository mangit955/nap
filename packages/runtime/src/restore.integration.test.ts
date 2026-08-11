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
 */

import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { E2BSandboxManager } from "@nap/sandbox/e2b-sandbox-manager";
import { commitAll, currentSha } from "@nap/sandbox/git";
import { NAP_TEMPLATE, TEMPLATE_FILES, TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openProject } from "./restore.ts";
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

const manager = new E2BSandboxManager({ template: NAP_TEMPLATE });
const objects = new InMemoryObjectStore();
const snapshots = new InMemorySnapshotStore();

/** Every sandbox this file created, so a failure part-way through still cleans up. */
const created: string[] = [];

/** The repository as git sees it: one line per tracked path, carrying its blob sha. */
let treeBefore: string;
let shaBefore: string;
let restoredSandboxId: string;

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
  // Moves the lockfile, which is what the restore uses to decide whether the image's baked
  // `node_modules` still matches. Appended rather than written, so this works whether or not
  // the template already tracks one.
  await sh(sandboxId, 'printf "\\n# nap round trip\\n" >> bun.lock');

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

  const opened = await openProject({ sandbox: manager, objects, snapshots, projectId: PROJECT });
  if (!opened.ok) throw new Error(`could not open the project: ${opened.error.message}`);
  created.push(opened.value.sandboxId);
  restoredSandboxId = opened.value.sandboxId;

  expect(opened.value).toMatchObject({ restored: true, warning: null });
  // The lockfile moved, so the baked dependencies are no longer the project's.
  expect(opened.value.installed).toBe(true);
});

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
