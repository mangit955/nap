import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeRepositoryBundle, encodeRepositoryBundle } from "@nap/sandbox/git-bundle";
import { localGitEnvironment } from "@nap/sandbox/testing/local-git-environment";
import { afterEach, expect, it } from "vitest";
import { ServerGitBroker } from "./git-broker.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: localGitEnvironment(cwd),
  }).trim();
it("imports full history and pushes only a dedicated branch, preserving remote changes on retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nap-broker-test-"));
  directories.push(dir);
  git(dir, "init", "-b", "main");
  await writeFile(join(dir, "file.txt"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");
  git(dir, "tag", "v1");
  git(dir, "branch", "other");
  const base = git(dir, "rev-parse", "HEAD");
  const broker = new ServerGitBroker({ remoteFor: () => dir, allowLocalTransport: true });
  const imported = await broker.fetch({
    fullName: "org/repo",
    branch: "main",
    token: "must-not-persist",
  });
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  const decoded = decodeRepositoryBundle(imported.value);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  expect(decoded.value.head).toBe("refs/heads/main");
  const bundlePath = join(dir, "source.bundle");
  await writeFile(bundlePath, decoded.value.bundle);
  expect(git(dir, "bundle", "list-heads", bundlePath)).toContain("refs/heads/other");
  expect(git(dir, "bundle", "list-heads", bundlePath)).toContain("refs/tags/v1");
  git(dir, "checkout", "-b", "nap/job");
  await writeFile(join(dir, "file.txt"), "change\n");
  git(dir, "add", "file.txt");
  git(dir, "commit", "-m", "change");
  const head = git(dir, "rev-parse", "HEAD");
  const outgoing = join(dir, "out.bundle");
  git(dir, "bundle", "create", outgoing, "--all", "HEAD");
  const bytes = encodeRepositoryBundle(
    new Uint8Array(await readFile(outgoing)),
    "refs/heads/nap/job",
  );
  git(dir, "checkout", "main");
  git(dir, "branch", "-D", "nap/job");
  const pushed = await broker.push({
    fullName: "org/repo",
    branch: "nap/job",
    sha: head,
    bytes,
    token: "must-not-persist",
  });
  expect(pushed.ok).toBe(true);
  expect(git(dir, "rev-parse", "nap/job")).toBe(head);
  expect(git(dir, "rev-parse", "main")).toBe(base);
  expect(
    await broker.push({
      fullName: "org/repo",
      branch: "nap/job",
      sha: head,
      bytes,
      token: "secret",
    }),
  ).toMatchObject({ ok: true });
  git(dir, "checkout", "nap/job");
  await writeFile(join(dir, "file.txt"), "human\n");
  git(dir, "commit", "-am", "human");
  const human = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "main");
  expect(
    await broker.push({
      fullName: "org/repo",
      branch: "nap/job",
      sha: head,
      bytes,
      token: "secret",
    }),
  ).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(git(dir, "rev-parse", "nap/job")).toBe(human);
  expect(await readFile(join(dir, ".git", "config"), "utf8")).not.toContain("must-not-persist");
});
it("rejects invalid branches and already cancelled operations without running Git", async () => {
  const broker = new ServerGitBroker();
  expect(
    await broker.fetch({ fullName: "org/repo", branch: "--evil", token: "secret" }),
  ).toMatchObject({ ok: false });
  expect(
    await broker.fetch({
      fullName: "org/repo",
      branch: "main",
      token: "secret",
      signal: AbortSignal.abort(),
    }),
  ).toMatchObject({ ok: false, error: { code: "cancelled" } });
});

async function repositoryWith(bytes: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nap-broker-test-"));
  directories.push(dir);
  git(dir, "init", "-b", "main");
  // Random, so neither zlib nor delta compression can shrink it under the limit.
  await writeFile(join(dir, "blob.bin"), randomBytes(bytes));
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");
  return dir;
}

it("stops a transfer that outgrows its disk allowance and leaves nothing behind", async () => {
  const dir = await repositoryWith(4 * 1024 * 1024);
  // A root of its own: other suites make `nap-git-` directories in the shared temp directory
  // from parallel workers, and a listing of that would blame this broker for them.
  const root = await mkdtemp(join(tmpdir(), "nap-broker-test-"));
  directories.push(root);
  const broker = new ServerGitBroker({
    remoteFor: () => {
      // Another worker's directory appearing mid-transfer, which this test must not notice.
      const elsewhere = join(tmpdir(), `nap-git-elsewhere-${randomBytes(4).toString("hex")}`);
      mkdirSync(elsewhere);
      directories.push(elsewhere);
      return dir;
    },
    allowLocalTransport: true,
    maxWorkingBytes: 1024 * 1024,
    temporaryRoot: root,
  });

  const imported = await broker.fetch({ fullName: "org/repo", branch: "main", token: "secret" });

  expect(imported).toMatchObject({
    ok: false,
    error: { code: "conflict", message: expect.stringContaining("too large") },
  });
  expect(await readdir(root)).toEqual([]);
  // The same repository fits a normal allowance, so the refusal above was the limit's doing.
  const roomy = new ServerGitBroker({ remoteFor: () => dir, allowLocalTransport: true });
  expect(
    await roomy.fetch({ fullName: "org/repo", branch: "main", token: "secret" }),
  ).toMatchObject({ ok: true });
});

it("runs no more transfers at once than it is allowed", async () => {
  const dir = await repositoryWith(1024);
  const order: string[] = [];
  const broker = new ServerGitBroker({
    remoteFor: () => {
      order.push("start");
      return dir;
    },
    allowLocalTransport: true,
    maxConcurrent: 1,
  });
  const transfer = () => broker.fetch({ fullName: "org/repo", branch: "main", token: "secret" });

  const results = await Promise.all([
    transfer().then((result) => {
      order.push("end");
      return result;
    }),
    transfer(),
  ]);

  expect(results).toMatchObject([{ ok: true }, { ok: true }]);
  expect(order.slice(0, 3)).toEqual(["start", "end", "start"]);
});

it("gives up its place in line when cancelled while waiting", async () => {
  const dir = await repositoryWith(1024);
  const broker = new ServerGitBroker({
    remoteFor: () => dir,
    allowLocalTransport: true,
    maxConcurrent: 1,
  });
  const waiting = new AbortController();
  const first = broker.fetch({ fullName: "org/repo", branch: "main", token: "secret" });
  const second = broker.fetch({
    fullName: "org/repo",
    branch: "main",
    token: "secret",
    signal: waiting.signal,
  });
  waiting.abort();

  expect(await second).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(await first).toMatchObject({ ok: true });
  expect(
    await broker.fetch({ fullName: "org/repo", branch: "main", token: "secret" }),
  ).toMatchObject({ ok: true });
});
