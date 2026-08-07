/**
 * Checks that a sandbox created from the Nap template really is a ready-to-run project.
 *
 * This does not build the template — that is `bun run template:build`, a manual step.
 * If the template is missing, these fail, and that is the intended signal.
 *
 * The assertion that earns this task is `node_modules`: the whole reason for a custom
 * template is that dependencies are baked into the image rather than installed on
 * creation. A project that merely *works* is not enough; it has to work without an
 * install, and the recorded cold start is the evidence.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { E2BSandboxManager } from "./e2b-sandbox-manager.ts";
import { NAP_TEMPLATE, TEMPLATE_DEV_PORT, TEMPLATE_FILES, TEMPLATE_WORKDIR } from "./template.ts";

if (process.env.E2B_API_KEY === undefined || process.env.E2B_API_KEY === "") {
  throw new Error(
    "E2B_API_KEY is not set, so the template check cannot verify anything. " +
      "Put it in apps/api/.env or export it, then re-run `bun run test:integration`.",
  );
}

const manager = new E2BSandboxManager({ template: NAP_TEMPLATE });

let sandboxId: string;
/** Time from "create a project" to "sandbox usable". */
let coldStartMs: number;
/** Time from "create a project" to "the preview URL serves" — what a user actually waits for. */
let previewReadyMs: number;
let previewUrl: string;

beforeAll(async () => {
  const startedAt = Date.now();
  const created = await manager.create("template-check");
  coldStartMs = Date.now() - startedAt;

  if (!created.ok) {
    throw new Error(
      `could not create a sandbox from template "${NAP_TEMPLATE}": ${created.error.message}. ` +
        "If it does not exist yet, run `bun run template:build` in packages/sandbox.",
    );
  }
  sandboxId = created.value.id;

  const ready = await manager.waitForPreview(sandboxId, TEMPLATE_DEV_PORT);
  previewReadyMs = Date.now() - startedAt;
  if (!ready.ok) {
    throw new Error(`preview never became ready: ${ready.error.message}`);
  }
  previewUrl = ready.value;
});

afterAll(async () => {
  if (sandboxId !== undefined) await manager.destroy(sandboxId);
});

/** Runs a command in the project directory and fails loudly if the sandbox is unreachable. */
async function run(command: string): Promise<{ exitCode: number; stdout: string }> {
  const result = await manager.exec(sandboxId, `cd ${TEMPLATE_WORKDIR} && ${command}`);
  if (!result.ok) throw new Error(`exec failed: ${result.error.message}`);
  return { exitCode: result.value.exitCode, stdout: result.value.stdout };
}

it("contains every file the starter project is defined to have", async () => {
  const listed = await run(`ls -1 ${TEMPLATE_FILES.map((f) => `'${f}'`).join(" ")} 2>&1`);

  expect(listed.stdout).not.toContain("No such file");
  expect(listed.exitCode).toBe(0);
});

it("has dependencies already installed, so creation does not pay for an install", async () => {
  // react specifically, not just the directory: an empty node_modules would pass a
  // bare existence check while leaving the app unable to start.
  const result = await run("test -d node_modules/react && test -d node_modules/vite");

  expect(result.exitCode).toBe(0);
});

it("type-checks, so the starter app is not merely present but valid", async () => {
  // Nothing in our own toolchain compiles the template — it has its own tsconfig, React
  // and Vite. Inside the sandbox is the one place its dependencies exist, so this is
  // the only check that would catch a broken starter app before a user sees it.
  // `--bun` runs the compiler under Bun's runtime. TypeScript's `bin/tsc` has no file
  // extension, and its package is `"type": "module"`, which Node's ESM loader refuses
  // to load at all — so the plain `bunx tsc` spelling fails before compiling anything.
  const result = await run("bunx --bun tsc --noEmit 2>&1");

  expect(result.stdout.trim()).toBe("");
  expect(result.exitCode).toBe(0);
});

it("starts from exactly one commit, with nothing left uncommitted", async () => {
  const log = await run("git log --oneline");
  const status = await run("git status --porcelain");

  // The exit codes are load-bearing. Outside a repository these commands fail to
  // stderr and leave stdout empty, and an empty string still splits into one element —
  // so without this the whole case passed against a directory with no git repo at all.
  expect(log.exitCode).toBe(0);
  expect(status.exitCode).toBe(0);
  expect(log.stdout.trim().split("\n")).toHaveLength(1);
  // An initial commit that missed files would leave the project dirty from the start,
  // and every later diff would be against an incomplete baseline.
  expect(status.stdout.trim()).toBe("");
});

it("does not track node_modules, so snapshots stay small", async () => {
  // The first build of this template committed all of node_modules, because the starter
  // app had no .gitignore — and `git status` was clean either way, so nothing else here
  // would have noticed. Project snapshots are git bundles, so tracking it would make
  // every save enormous.
  const tracked = await run("git ls-files node_modules");

  expect(tracked.exitCode).toBe(0);
  expect(tracked.stdout.trim()).toBe("");
});

it("serves the starter app over the public preview URL", async () => {
  const response = await fetch(previewUrl);
  const body = await response.text();

  expect(response.status).toBe(200);
  // The mount point and the module script the app actually boots from.
  expect(body).toContain('<div id="root">');
  expect(body).toContain("/src/main.tsx");
});

it("serves modules through Vite rather than as files off disk", async () => {
  // The distinction that matters: a plain file server would hand back the raw TSX and
  // the browser would fail on the first angle bracket. Requesting the entry module and
  // finding no JSX left in it is what proves a dev server is really running.
  const response = await fetch(new URL("/src/main.tsx", previewUrl));
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("javascript");
  expect(body).not.toContain("<StrictMode>");
});

it("reports a typed timeout when nothing serves a port, instead of hanging", async () => {
  // The task's explicit failure requirement. 39517 is arbitrary and unused; the point is
  // that an unreachable preview ends the wait rather than the turn.
  const startedAt = Date.now();
  const result = await manager.waitForPreview(sandboxId, 39_517, { timeoutMs: 3_000 });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("timeout");
  expect(Date.now() - startedAt).toBeLessThan(15_000);
});

it("records the cold start and preview boot times", () => {
  // Not upper bounds — hardware and region move them around, and a flaky threshold in an
  // integration suite teaches people to re-run rather than to look. The task asks for the
  // numbers to be measured and written down; this prints them.
  console.log(
    `\n  cold start (create → usable):        ${(coldStartMs / 1000).toFixed(2)}s` +
      `\n  preview ready (create → serves 200): ${(previewReadyMs / 1000).toFixed(2)}s` +
      `\n  preview URL: ${previewUrl}\n`,
  );
  expect(coldStartMs).toBeGreaterThan(0);
  expect(previewReadyMs).toBeGreaterThanOrEqual(coldStartMs);
});
