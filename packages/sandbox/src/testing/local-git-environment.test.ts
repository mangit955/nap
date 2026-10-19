import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { localGitEnvironment } from "./local-git-environment.ts";

it("keeps fixture Git out of an inherited hook's repository, index, config, and hooks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nap-git-isolation-"));
  const sentinel = join(directory, "sentinel");
  const fixture = join(directory, "fixture");
  // Construct this independently so even a regression in the helper cannot
  // redirect the sentinel's own setup to the real checkout running this test.
  const sentinelEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: directory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@nap.dev", ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const state = async () => ({
    head: git(sentinel, sentinelEnv, "rev-parse", "HEAD"),
    refs: git(sentinel, sentinelEnv, "show-ref"),
    config: await readFile(join(sentinel, ".git/config"), "utf8"),
    index: await readFile(join(sentinel, ".git/index")),
  });
  try {
    await mkdir(sentinel);
    await mkdir(fixture);
    git(sentinel, sentinelEnv, "init", "-b", "main");
    await writeFile(join(sentinel, "file"), "sentinel");
    git(sentinel, sentinelEnv, "add", ".");
    git(sentinel, sentinelEnv, "commit", "-m", "sentinel");
    const before = await state();
    const hooks = join(directory, "hooks");
    await mkdir(hooks);
    await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    const globalConfig = join(directory, "global-config");
    await writeFile(globalConfig, `[core]\n\thooksPath = ${hooks}\n`);
    vi.stubEnv("GIT_DIR", join(sentinel, ".git"));
    vi.stubEnv("GIT_WORK_TREE", sentinel);
    vi.stubEnv("GIT_INDEX_FILE", join(sentinel, ".git/index"));
    vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.hooksPath");
    vi.stubEnv("GIT_CONFIG_VALUE_0", hooks);
    const env = localGitEnvironment(directory);
    git(fixture, env, "init", "-b", "main");
    await writeFile(join(fixture, "file"), "fixture");
    git(fixture, env, "add", ".");
    git(fixture, env, "commit", "-m", "fixture");
    git(fixture, env, "checkout", "-b", "nap/test");
    expect(git(fixture, env, "show", "HEAD:file")).toBe("fixture");
    expect(git(fixture, env, "branch", "--show-current")).toBe("nap/test");
    expect(await state()).toEqual(before);
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
