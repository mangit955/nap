import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
