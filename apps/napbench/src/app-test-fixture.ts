import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppTestTask } from "@nap/bench/app-test";
import type { VerifiedCheck } from "@nap/shared/events";

/** A real, reproducible source range, checked before the harness records a checkpoint. */
export function prepareAppTestFixture(task: AppTestTask) {
  const directory = mkdtempSync(join(tmpdir(), "nap-app-source-"));
  // A hook's GIT_DIR or GIT_INDEX_FILE must never redirect this disposable repository.
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.autocrlf=false",
        "-c",
        "user.name=NapBench",
        "-c",
        "user.email=bench@nap.test",
        ...args,
      ],
      {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...inheritedEnv,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_DATE: "2026-10-24T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-10-24T00:00:00Z",
        },
      },
    );
  const dispose = () => rmSync(directory, { recursive: true, force: true });
  try {
    git(["init", "--quiet", "--initial-branch=fixture"]);
    mkdirSync(join(directory, "src"));
    writeFileSync(
      join(directory, "index.html"),
      "<!doctype html><title>App</title><p>Preparing app</p>\n",
    );
    writeFileSync(join(directory, "src/app.js"), "// App entry point\n");
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "Initial app"]);
    const baseSha = git(["rev-parse", "HEAD"]).trim();
    const specimen = join(
      dirname(fileURLToPath(import.meta.url)),
      "../fixtures/app-test",
      task.fixture,
    );
    const files = {
      "index.html": readFileSync(join(specimen, "index.html"), "utf8"),
      "src/app.js": readFileSync(
        join(specimen, task.variant === "correct" ? "app.js" : "app-buggy.js"),
        "utf8",
      ),
    };
    for (const [path, contents] of Object.entries(files))
      writeFileSync(join(directory, path), contents);
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "Implement app flow"]);
    const commitSha = git(["rev-parse", "HEAD"]).trim();
    const verify = () => {
      execFileSync("node", ["--check", "src/app.js"], { cwd: directory, stdio: "pipe" });
      git(["diff", "--check", `${commitSha}^`, commitSha]);
      if (git(["rev-parse", "HEAD"]).trim() !== commitSha || git(["status", "--porcelain"]).trim())
        throw new Error("Fixture source changed after checkpoint.");
    };
    verify();
    const checks: VerifiedCheck[] = [{ name: "fixture-syntax", outcome: "passed", output: null }];
    return {
      directory,
      files,
      baseSha,
      commitSha,
      diff: git(["diff", "--no-ext-diff", "--no-textconv", `${commitSha}^`, commitSha, "--"]),
      checks,
      git,
      verify,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
