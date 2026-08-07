/**
 * The bundle round trip, against real git in a real sandbox.
 *
 * The unit tests pin the command sequences, but they cannot tell whether those commands
 * actually reconstruct a repository — only git can answer that, and snapshot/restore is
 * the mechanism a user's whole project depends on surviving. If this is wrong, projects
 * are lost, and no amount of scripted `exec` would have said so.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { E2BSandboxManager } from "./e2b-sandbox-manager.ts";
import { bundle, commitAll, currentSha, restoreBundle } from "./git.ts";
import { NAP_TEMPLATE, TEMPLATE_WORKDIR } from "./template.ts";

if (process.env.E2B_API_KEY === undefined || process.env.E2B_API_KEY === "") {
  throw new Error(
    "E2B_API_KEY is not set, so the git round trip cannot verify anything. " +
      "Put it in apps/api/.env or export it, then re-run `bun run test:integration`.",
  );
}

const manager = new E2BSandboxManager({ template: NAP_TEMPLATE });
let sandboxId: string;

beforeAll(async () => {
  const created = await manager.create("git-round-trip");
  if (!created.ok) throw new Error(`could not create a sandbox: ${created.error.message}`);
  sandboxId = created.value.id;
});

afterAll(async () => {
  if (sandboxId !== undefined) await manager.destroy(sandboxId);
});

async function sh(command: string): Promise<{ exitCode: number; stdout: string }> {
  const result = await manager.exec(sandboxId, `cd ${TEMPLATE_WORKDIR} && ${command}`);
  if (!result.ok) throw new Error(`exec failed: ${result.error.message}`);
  return { exitCode: result.value.exitCode, stdout: result.value.stdout };
}

it("commits real changes and reports the new sha", async () => {
  const before = await currentSha(manager, sandboxId);
  expect(before.ok).toBe(true);

  const written = await manager.writeFile(
    sandboxId,
    `${TEMPLATE_WORKDIR}/src/feature.ts`,
    "export const answer = 42;\n",
  );
  expect(written.ok).toBe(true);

  const committed = await commitAll(manager, sandboxId, 'Add feature: it\'s "done" $(now)');

  expect(committed.ok).toBe(true);
  if (!committed.ok || !before.ok) return;
  expect(committed.value.committed).toBe(true);
  expect(committed.value.sha).not.toBe(before.value);

  // The hostile message was stored as a message, not executed as a command.
  const subject = await sh("git log -1 --pretty=%s");
  expect(subject.stdout.trim()).toBe('Add feature: it\'s "done" $(now)');
});

it("treats a second commit with no changes as a no-op", async () => {
  const before = await currentSha(manager, sandboxId);

  const result = await commitAll(manager, sandboxId, "nothing to do");

  expect(result.ok).toBe(true);
  if (!result.ok || !before.ok) return;
  expect(result.value).toEqual({ committed: false, sha: null });
  // The repository did not move, which is the part that actually matters.
  expect(await currentSha(manager, sandboxId)).toEqual({ ok: true, value: before.value });
});

it("round-trips the repository through a bundle", async () => {
  const expectedSha = await currentSha(manager, sandboxId);
  const snapshot = await bundle(manager, sandboxId);

  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok || !expectedSha.ok) return;
  // A git bundle starts with a signature line; anything else means we captured stray
  // output rather than a bundle.
  expect(new TextDecoder().decode(snapshot.value.slice(0, 22))).toContain("# v2 git bundle");

  // Destroy the working state as thoroughly as a fresh sandbox would: lose the commit,
  // lose the file, and add junk that the restore is expected to sweep away.
  await sh("git reset --hard HEAD~1 && rm -f src/feature.ts && echo junk > src/junk.ts");
  expect((await sh("test -f src/feature.ts")).exitCode).not.toBe(0);

  const restored = await restoreBundle(manager, sandboxId, snapshot.value);
  expect(restored.ok).toBe(true);

  // The commit is back...
  expect(await currentSha(manager, sandboxId)).toEqual({ ok: true, value: expectedSha.value });
  // ...and so are its contents.
  const contents = await manager.readFile(sandboxId, `${TEMPLATE_WORKDIR}/src/feature.ts`);
  expect(contents).toEqual({ ok: true, value: "export const answer = 42;\n" });
  // ...and the untracked junk is gone.
  expect((await sh("test -f src/junk.ts")).exitCode).not.toBe(0);
});

it("leaves the baked node_modules intact through a restore", async () => {
  // `git clean -fdx` would delete it, because it is ignored — and a project open would
  // silently turn from one second into a full reinstall.
  const result = await sh("test -d node_modules/react && test -d node_modules/vite");

  expect(result.exitCode).toBe(0);
});
