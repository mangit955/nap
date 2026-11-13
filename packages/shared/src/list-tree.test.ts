import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listTreeCommand, listTreeViaExec, parseListTree, walkBreadthFirst } from "./list-tree.ts";
import type {
  ExecOptions,
  ExecResult,
  SandboxError,
  SandboxManager,
} from "./ports/sandbox-manager.ts";
import type { Result } from "./result.ts";

const run = promisify(execFile);

/**
 * This machine's environment minus git's own variables. A commit hook runs with `GIT_DIR` and
 * `GIT_INDEX_FILE` exported, and a git started under them reads *this* repository whatever
 * directory it is in — so the fixtures' git would list the repo's files, and their `find` would
 * never run. A sandbox has no such variables.
 */
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);
const EXCLUDE = ["node_modules", ".git", "dist"];

/**
 * A sandbox whose `exec` is real bash on this machine, counting what it was asked to run.
 *
 * Real rather than scripted because everything this module can get wrong lives in a shell —
 * quoting, the git-then-find fallback, NUL separation — and a scripted answer would prove only
 * which string was sent.
 */
function bash(): Pick<SandboxManager, "exec"> & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    async exec(_id, command): Promise<Result<ExecResult, SandboxError>> {
      commands.push(command);
      try {
        const { stdout, stderr } = await run("bash", ["-c", command], { encoding: "utf8", env });
        return { ok: true, value: { exitCode: 0, stdout, stderr } };
      } catch (cause) {
        const failed = cause as { code?: number; stdout?: string; stderr?: string };
        return {
          ok: true,
          value: {
            exitCode: failed.code ?? 1,
            stdout: failed.stdout ?? "",
            stderr: failed.stderr ?? "",
          },
        };
      }
    },
  };
}

let root: string;

async function put(relative: string): Promise<void> {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "x");
}

/** Names chosen to break a parser that splits on whitespace or newlines, or quotes badly. */
const AWKWARD = ["src/my file.ts", "src/naïve.ts", "src/new\nline.ts", "src/it's.ts"];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "list-tree-"));
  for (const path of ["package.json", "src/App.tsx", "node_modules/react/index.js", "dist/a.js"])
    await put(path);
  for (const path of AWKWARD) await put(path);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function listed(): Promise<string[]> {
  const sandbox = bash();
  const result = await listTreeViaExec(sandbox, "sbx", root, {
    exclude: EXCLUDE,
    timeoutMs: 10_000,
  });
  if (!result.ok) throw new Error(result.error.message);
  expect(sandbox.commands).toHaveLength(1);
  return result.value.map((path) => path.slice(root.length + 1)).sort();
}

describe("listTreeViaExec", () => {
  it("lists a workspace that is not a repository with one command, through the fallback", async () => {
    expect(await listed()).toEqual(["package.json", "src/App.tsx", ...AWKWARD].sort());
  });

  it("lists a repository with one command, honouring .gitignore and keeping uncommitted files", async () => {
    await run("git", ["init", "-q"], { cwd: root, env });
    await writeFile(join(root, ".gitignore"), "node_modules\nignored.log\n");
    await put("ignored.log");
    await run("git", ["add", "package.json", ".gitignore"], { cwd: root, env });
    // `dist/` committed anyway: git lists it, and the exclusion must still hold.
    await run("git", ["add", "-f", "dist/a.js"], { cwd: root, env });

    expect(await listed()).toEqual(
      [".gitignore", "package.json", "src/App.tsx", ...AWKWARD].sort(),
    );
  });

  it("leaves out what the agent deleted or moved and has not committed yet", async () => {
    // The index still names both until the turn commits; the disk is what the model will read.
    await run("git", ["init", "-q"], { cwd: root, env });
    await put("src/gone.ts");
    await put("src/before.ts");
    await run("git", ["add", "package.json", "src/gone.ts", "src/before.ts"], { cwd: root, env });
    await rm(join(root, "src/gone.ts"));
    await rename(join(root, "src/before.ts"), join(root, "src/after.ts"));

    expect(await listed()).toEqual(
      ["package.json", "src/App.tsx", "src/after.ts", ...AWKWARD].sort(),
    );
  });

  it("keeps the files nobody has committed yet when an unignored node_modules is bigger than the ceiling", async () => {
    // No `.gitignore`, as in an imported repository that never had one: the untracked call would
    // print every dependency, and the ceiling would cut the files the agent wrote this turn.
    await run("git", ["init", "-q"], { cwd: root, env });
    await run("git", ["add", "package.json", "src/App.tsx"], { cwd: root, env });
    for (let n = 0; n < 40; n += 1) await put(`node_modules/some-package/module-${n}.js`);
    const ceiling = 400;

    const { stdout } = await run("bash", ["-c", listTreeCommand(root, EXCLUDE, ceiling)], {
      encoding: "utf8",
      env,
    });
    const paths = parseListTree(root, stdout, EXCLUDE).map((path) => path.slice(root.length + 1));

    expect(paths).toContain("package.json");
    expect(paths).toContain("src/App.tsx");
    expect(paths).toContain("src/my file.ts");
  });

  it("keeps the project's own files when an unignored folder nobody excluded is bigger than the ceiling", async () => {
    // `vendor/` is not one of the names excluded, and nothing ignores it. Untracked bulk of any
    // name must be what the ceiling cuts, not the tracked files after it.
    await run("git", ["init", "-q"], { cwd: root, env });
    await run("git", ["add", "package.json", "src/App.tsx"], { cwd: root, env });
    for (let n = 0; n < 40; n += 1) await put(`vendor/some-library/module-${n}.js`);
    const ceiling = 400;

    const { stdout } = await run("bash", ["-c", listTreeCommand(root, EXCLUDE, ceiling)], {
      encoding: "utf8",
      env,
    });
    const paths = parseListTree(root, stdout, EXCLUDE).map((path) => path.slice(root.length + 1));

    expect(paths).toContain("package.json");
    expect(paths).toContain("src/App.tsx");
  });

  it("fails rather than listing nothing when the root does not exist", async () => {
    const result = await listTreeViaExec(bash(), "sbx", join(root, "missing"), {
      exclude: EXCLUDE,
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(false);
  });

  it.each(["x", "é"])(
    "rejects a listing at its raw byte ceiling, including multibyte paths (%s)",
    async (character) => {
      // Complete NUL-separated records can still hide the rest of the project. The byte bound
      // applies before exclusions, so none of the surviving records need be project files.
      const ceiling = 1_048_576;
      const stem = "dist/";
      const remaining = ceiling - stem.length - 1;
      const stdout = `${stem}${character.repeat(Math.floor(remaining / Buffer.byteLength(character)))}${"x".repeat(
        remaining % Buffer.byteLength(character),
      )}\0`;
      expect(Buffer.byteLength(stdout)).toBe(ceiling);

      const result = await listTreeViaExec(
        { exec: async () => ({ ok: true, value: { exitCode: 0, stdout, stderr: "" } }) },
        "sbx",
        root,
        { exclude: EXCLUDE, timeoutMs: 10_000 },
      );

      expect(result).toEqual({
        ok: false,
        error: {
          code: "unavailable",
          message: expect.stringContaining("listing reached its 1048576-byte limit"),
        },
      });
    },
  );

  it("accepts a complete listing just below the raw byte ceiling", async () => {
    const kept = "\0kept.ts\0";
    const stdout = `dist/${"x".repeat(1_048_575 - 5 - kept.length)}${kept}`;
    expect(Buffer.byteLength(stdout)).toBe(1_048_575);

    const result = await listTreeViaExec(
      { exec: async () => ({ ok: true, value: { exitCode: 0, stdout, stderr: "" } }) },
      "sbx",
      root,
      { exclude: EXCLUDE, timeoutMs: 10_000 },
    );

    expect(result).toEqual({ ok: true, value: [`${root}/kept.ts`] });
  });

  it("passes the caller's timeout to the sandbox, and has it stop the listing at the deadline", async () => {
    let seen: ExecOptions | undefined;
    await listTreeViaExec(
      {
        exec: async (_id, _command, _onOutput, options) => {
          seen = options;
          return { ok: true, value: { exitCode: 0, stdout: "", stderr: "" } };
        },
      },
      "sbx",
      "/home/user/app",
      { exclude: [], timeoutMs: 4_321 },
    );

    expect(seen?.timeoutMs).toBe(4_321);
    // Without it the provider kills only the shell it started, and `git` or `find` carries on.
    expect(seen?.stopOnGiveUp).toBe(true);
  });
});

describe("parseListTree", () => {
  it("drops a record the output ceiling cut in half", () => {
    expect(parseListTree("/r", "a.ts\0b/c.ts\0d/partia", [])).toEqual(["/r/a.ts", "/r/b/c.ts"]);
  });

  it("takes away what the git branch listed before its empty record", () => {
    expect(parseListTree("/r", "gone.ts\0\0gone.ts\0kept.ts\0", [])).toEqual(["/r/kept.ts"]);
  });

  it("lists a conflicted path once, though git prints it per merge stage", () => {
    expect(parseListTree("/r", "a.ts\0a.ts\0a.ts\0", [])).toEqual(["/r/a.ts"]);
  });

  it("quotes the root, so a path with a quote in it cannot escape the command", () => {
    expect(listTreeCommand("/tmp/it's", [])).toContain("cd '/tmp/it'\\''s'");
  });
});

describe("walkBreadthFirst", () => {
  const ROOT = "/home/user/app";
  const at = (...relative: string[]) => relative.map((path) => `${ROOT}/${path}`);

  it("takes files shallowest first, each folder's in order, whatever order they were listed in", () => {
    const listing = at("src/b/deep.ts", "z.ts", "src/main.ts", "a.ts", "src/b/c/deeper.ts");

    expect(walkBreadthFirst(ROOT, listing, { maxEntries: 10 })).toEqual({
      paths: at("a.ts", "z.ts", "src/main.ts", "src/b/deep.ts", "src/b/c/deeper.ts"),
      truncated: false,
    });
    expect(walkBreadthFirst(ROOT, [...listing].reverse(), { maxEntries: 10 }).paths).toEqual(
      walkBreadthFirst(ROOT, listing, { maxEntries: 10 }).paths,
    );
  });

  it("never lets a deep file displace a shallow one when the cap bites, and says it bit", () => {
    // Listed deepest first, the order a git index can hand back a nested package.
    const listing = at("a/b/c/d/e/f.ts", "a/b/c/d/e.ts", "a/b/c/d.ts", "a/b/c.ts", "a.ts", "b.ts");

    expect(walkBreadthFirst(ROOT, listing, { maxEntries: 3 })).toEqual({
      paths: at("a.ts", "b.ts", "a/b/c.ts"),
      truncated: true,
    });
  });

  it("does not report a cut when the cap is exactly the project", () => {
    expect(walkBreadthFirst(ROOT, at("a.ts", "src/b.ts"), { maxEntries: 2 })).toEqual({
      paths: at("a.ts", "src/b.ts"),
      truncated: false,
    });
  });

  it("stops at a depth limit when given one, and says what it left out", () => {
    const listing = at("a.ts", "src/b.ts", "src/c/d.ts");

    expect(walkBreadthFirst(ROOT, listing, { maxEntries: 10, maxDepth: 1 })).toEqual({
      paths: at("a.ts", "src/b.ts"),
      truncated: true,
    });
  });

  it("ignores what is not under the root, and a root given with a trailing slash", () => {
    const listing = [...at("a.ts"), "/home/user/other/b.ts", "/home/user/application.ts"];

    expect(walkBreadthFirst(`${ROOT}/`, listing, { maxEntries: 10 })).toEqual({
      paths: at("a.ts"),
      truncated: false,
    });
  });

  it("counts a path listed twice once", () => {
    expect(walkBreadthFirst(ROOT, at("a.ts", "a.ts"), { maxEntries: 1 })).toEqual({
      paths: at("a.ts"),
      truncated: false,
    });
  });

  it("answers an empty listing with nothing, uncut", () => {
    expect(walkBreadthFirst(ROOT, [], { maxEntries: 10 })).toEqual({ paths: [], truncated: false });
  });
});
