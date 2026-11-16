import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DONE,
  FAILED,
  linkEnvFiles,
  liveSetupPid,
  MARKER_DIR,
  mainCheckoutFrom,
  RUNNING,
  tailOf,
  withoutGitEnv,
} from "../scripts/setup-worktree.ts";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "setup-worktree.ts");
// A value that must never reach any output: the script links env files but never reads them.
const SECRET = "fixture-secret-never-printed";
const PACKAGE = {
  name: "fixture",
  private: true,
  scripts: { prepare: "echo prepare saw [$FIXTURE_KEY]" },
};

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  // realpath: macOS's tmpdir is a symlink, and git reports worktree paths resolved.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "nap-setup-")));
  scratch.push(dir);
  return dir;
}

describe("mainCheckoutFrom", () => {
  it("takes the first worktree, which git always lists as the main checkout", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /elsewhere/feature",
      "HEAD def",
      "branch refs/heads/feature",
      "",
    ].join("\n");
    expect(mainCheckoutFrom(porcelain)).toBe("/repo");
  });

  it("finds no checkout in a bare repository", () => {
    expect(mainCheckoutFrom("worktree /repo.git\nbare\n\nworktree /wt\nHEAD abc\n")).toBeNull();
  });

  it("finds nothing in empty output", () => {
    expect(mainCheckoutFrom("")).toBeNull();
  });
});

describe("linkEnvFiles", () => {
  function fixture() {
    const main = tempDir();
    const worktree = tempDir();
    mkdirSync(join(main, "apps", "api"), { recursive: true });
    writeFileSync(join(main, ".env.local"), SECRET);
    writeFileSync(join(main, "apps", "api", ".env"), SECRET);
    return { main, worktree };
  }

  it("links each file the main checkout has and skips the rest", () => {
    const { main, worktree } = fixture();
    const outcomes = linkEnvFiles(main, worktree, [".env.local", "apps/api/.env", ".env"]);
    expect(outcomes).toEqual([
      { file: ".env.local", result: "linked" },
      { file: "apps/api/.env", result: "linked" },
      { file: ".env", result: "missing" },
    ]);
    expect(readlinkSync(join(worktree, "apps", "api", ".env"))).toBe(join(main, "apps/api/.env"));
    expect(existsSync(join(worktree, ".env"))).toBe(false);
  });

  it("changes nothing when run a second time", () => {
    const { main, worktree } = fixture();
    linkEnvFiles(main, worktree, [".env.local"]);
    expect(linkEnvFiles(main, worktree, [".env.local"])).toEqual([
      { file: ".env.local", result: "linked" },
    ]);
    expect(readlinkSync(join(worktree, ".env.local"))).toBe(join(main, ".env.local"));
  });

  it("keeps a real file the worktree already has", () => {
    const { main, worktree } = fixture();
    writeFileSync(join(worktree, ".env.local"), "worktree's own");
    expect(linkEnvFiles(main, worktree, [".env.local"])).toEqual([
      { file: ".env.local", result: "kept" },
    ]);
    expect(lstatSync(join(worktree, ".env.local")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(worktree, ".env.local"), "utf8")).toBe("worktree's own");
  });

  it("repoints a symlink that leads somewhere else", () => {
    const { main, worktree } = fixture();
    symlinkSync("/nowhere", join(worktree, ".env.local"));
    linkEnvFiles(main, worktree, [".env.local"]);
    expect(readlinkSync(join(worktree, ".env.local"))).toBe(join(main, ".env.local"));
  });

  it("does nothing in the main checkout itself", () => {
    const { main } = fixture();
    expect(linkEnvFiles(main, main, [".env.local"])).toEqual([]);
    expect(lstatSync(join(main, ".env.local")).isFile()).toBe(true);
  });

  it("refuses a file that would land outside the worktree", () => {
    const { main, worktree } = fixture();
    expect(() => linkEnvFiles(main, worktree, ["../.env.local"])).toThrow(/outside the worktree/);
  });
});

describe("tailOf", () => {
  it("keeps the last lines of the output", () => {
    const output = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    expect(tailOf(`${output}\n\n`, 3)).toBe("line 47\nline 48\nline 49");
  });
});

describe("withoutGitEnv", () => {
  it("drops git's own variables and keeps the rest", () => {
    expect(withoutGitEnv({ GIT_DIR: "/x", GIT_INDEX_FILE: "/y", PATH: "/bin" })).toEqual({
      PATH: "/bin",
    });
  });
});

describe("liveSetupPid", () => {
  it("reads a marker naming a live process", () => {
    const dir = tempDir();
    // PID 1 is always alive; this process's own PID would not do, since a setup ignores itself.
    writeFileSync(join(dir, RUNNING), "1\n");
    expect(liveSetupPid(dir)).toBe(1);
  });

  it("ignores a marker naming a dead process, or no marker at all", () => {
    const dir = tempDir();
    expect(liveSetupPid(dir)).toBeNull();
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
    writeFileSync(join(dir, RUNNING), String(dead.stdout));
    expect(liveSetupPid(dir)).toBeNull();
  });
});

// The script itself, run the way t3.json runs it, in a throwaway repository whose install is
// instant: a package with no dependencies.
describe("scripts/setup-worktree.ts", () => {
  function git(cwd: string, ...args: string[]) {
    // No hooks and no signing from whoever runs the suite: the fixture commit is not theirs.
    const flags = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];
    return execFileSync("git", [...flags, ...args], { cwd, encoding: "utf8", stdio: "pipe" });
  }

  function repository(): { main: string; worktree: string } {
    const main = tempDir();
    mkdirSync(join(main, "scripts"));
    copyFileSync(SCRIPT, join(main, "scripts", "setup-worktree.ts"));
    // `prepare` echoes the fixture's credential, standing in for any install script that reads
    // its environment.
    writeFileSync(join(main, "package.json"), JSON.stringify(PACKAGE));
    writeFileSync(join(main, ".gitignore"), ".env*\n.t3/\nnode_modules/\n");
    git(main, "init", "-q", "-b", "main");
    git(main, "add", ".");
    git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    writeFileSync(join(main, ".env.local"), `FIXTURE_KEY=${SECRET}\n`);
    const worktree = join(tempDir(), "wt");
    git(main, "worktree", "add", "-q", worktree);
    return { main, worktree };
  }

  function setup(cwd: string, env: NodeJS.ProcessEnv = process.env) {
    const run = spawnSync("bun", ["scripts/setup-worktree.ts"], { cwd, env, encoding: "utf8" });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  }

  function markers(cwd: string): string[] {
    return [RUNNING, DONE, FAILED].filter((name) => existsSync(join(cwd, MARKER_DIR, name)));
  }

  it("links env files, installs, and ends with setup-done", () => {
    const { main, worktree } = repository();
    const run = setup(worktree);
    expect(run.status).toBe(0);
    expect(markers(worktree)).toEqual([DONE]);
    expect(readlinkSync(join(worktree, ".env.local"))).toBe(join(main, ".env.local"));
    expect(existsSync(join(worktree, "node_modules"))).toBe(true);
    expect(run.output).toContain("prepare saw []");
    expect(run.output).not.toContain(SECRET);
    expect(git(worktree, "status", "--porcelain")).toBe("");
  });

  it("acts on its own repository when started with a git hook's variables", () => {
    const { main, worktree } = repository();
    const decoy = tempDir();
    git(decoy, "init", "-q");
    const before = git(decoy, "config", "--list", "--local");
    const run = setup(worktree, {
      ...process.env,
      GIT_DIR: join(decoy, ".git"),
      GIT_INDEX_FILE: join(decoy, ".git", "index"),
    });
    expect(run.status).toBe(0);
    expect(readlinkSync(join(worktree, ".env.local"))).toBe(join(main, ".env.local"));
    expect(git(decoy, "config", "--list", "--local")).toBe(before);
  });

  it("is safe to run twice", () => {
    const { worktree } = repository();
    setup(worktree);
    const second = setup(worktree);
    expect(second.status).toBe(0);
    expect(markers(worktree)).toEqual([DONE]);
  });

  it("leaves setup-failed with the install's error when the install fails", () => {
    const { worktree } = repository();
    writeFileSync(
      join(worktree, "package.json"),
      JSON.stringify({ ...PACKAGE, dependencies: { absent: "file:./absent" } }),
    );
    const run = setup(worktree);
    expect(run.status).not.toBe(0);
    expect(markers(worktree)).toEqual([FAILED]);
    const failed = readFileSync(join(worktree, MARKER_DIR, FAILED), "utf8");
    expect(failed).toMatch(/^Setup exited with code [1-9]/);
    expect(failed).toContain("absent");
  });

  it("clears a stale outcome when it starts again", () => {
    const { worktree } = repository();
    mkdirSync(join(worktree, MARKER_DIR));
    writeFileSync(join(worktree, MARKER_DIR, FAILED), "an earlier failure");
    expect(setup(worktree).status).toBe(0);
    expect(markers(worktree)).toEqual([DONE]);
  });

  it("leaves a setup that is still running alone", () => {
    const { worktree } = repository();
    mkdirSync(join(worktree, MARKER_DIR));
    writeFileSync(join(worktree, MARKER_DIR, RUNNING), "1\n");
    const run = setup(worktree);
    expect(run.status).toBe(1);
    expect(run.output).toMatch(/already running here as PID 1;/);
    expect(markers(worktree)).toEqual([RUNNING]);
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
  });

  it("links nothing in the main checkout itself", () => {
    const { main } = repository();
    const run = setup(main);
    expect(run.status).toBe(0);
    expect(markers(main)).toEqual([DONE]);
    expect(lstatSync(join(main, ".env.local")).isFile()).toBe(true);
    expect(readFileSync(join(main, ".env.local"), "utf8")).toBe(`FIXTURE_KEY=${SECRET}\n`);
  });
});

describe("t3.json", () => {
  it("runs the setup script that exists on worktree creation", () => {
    const config = JSON.parse(readFileSync(join(import.meta.dirname, "..", "t3.json"), "utf8"));
    const setups = config.scripts.filter(
      (script: { runOnWorktreeCreate?: boolean }) => script.runOnWorktreeCreate,
    );
    expect(setups.map((script: { command: string }) => script.command)).toEqual([
      "bun scripts/setup-worktree.ts",
    ]);
    expect(existsSync(SCRIPT)).toBe(true);
  });
});
