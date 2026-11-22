// Runs CI's checks on what this branch changed, in seconds rather than the minute the full
// suites take: Biome over the changed files, typecheck of the packages they live in and every
// package that depends on those, every test in the changed packages and every test elsewhere
// that imports or reads a changed file, and the Python gates when Python changed. CI still runs everything; this is the inner loop and the pre-commit hook.
//
//   bun run check:changed            changes since the merge base with origin/main, committed or not
//   bun run check:changed <ref>      changes since the merge base with <ref>
//   bun run check:changed --staged   only what the next commit holds (the pre-commit hook)
//
// The decision of which steps run for which files is `planChecks`, a pure function tested in
// test/check-changed.test.ts. Everything below it only gathers its inputs and runs its output.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

/** A workspace package, and the workspace packages its package.json depends on. */
export type Workspace = {
  readonly name: string;
  readonly dir: string;
  readonly dependsOn: readonly string[];
};
export type ChangedFile = { readonly path: string; readonly present: boolean };
/**
 * Commands run one after another, every one of them even after a failure, so one run reports
 * every failure; the step fails if any exits non-zero.
 */
export type Step = { readonly name: string; readonly commands: readonly (readonly string[])[] };
export type Plan = { readonly steps: readonly Step[]; readonly notes: readonly string[] };

export type PlanInput = {
  readonly files: readonly ChangedFile[];
  readonly workspaces: readonly Workspace[];
  /** Whether a Docker daemon answers: the `db` project starts a Postgres container. */
  readonly docker: boolean;
  /** Every `*.test.ts` and `*.test.tsx` in the repo, tracked or untracked. */
  readonly tests: readonly string[];
  /**
   * For each changed file's basename, the test files whose source names it: how a test in one
   * place that reads a file elsewhere as text (a root config, a script) is found.
   */
  readonly testsNaming: Readonly<Record<string, readonly string[]>>;
  /** Each test project's setup and global-setup files, from vitest.config.ts, keyed by path. */
  readonly setupFiles: Readonly<Record<string, string>>;
  /**
   * Tests that run a script as a separate `bun` process, with the workspace packages that script
   * imports. No import of the test's reaches them, so `related` cannot see what they exercise.
   */
  readonly processRunners: Readonly<Record<string, readonly string[]>>;
};

// A change to one of these can break any package, so it widens every step to the whole repo. The
// root package.json is not here: a dependency change there also changes bun.lock, and on its own
// it is a script edit, which would otherwise cost a full run.
const GLOBAL_FILES = new Set([
  "bun.lock",
  "tsconfig.base.json",
  "tsconfig.test-d.json",
  "turbo.json",
  "vitest.config.ts",
]);
// The root tsconfig's own program: TypeScript that belongs to no workspace.
const ROOT_PROGRAM = /^(test|scripts)\/|^vitest\.config\.ts$|^tsconfig\.json$/;
// What `vitest related` can follow: a file some test reaches through its imports.
const IMPORTABLE = /\.(?:[cm]?[jt]sx?|json)$/;
// Tests that read files as text without naming them, which neither the import graph, nor the
// changed workspace's node tests, nor `testsNaming` finds: reads from another workspace, and
// component tests (`.test.tsx`, left out of the workspace run below) that touch the filesystem.
// test/check-changed.test.ts fails when a component test imports node:fs and is not listed.
export const TREE_READERS = [
  // The Terminal-Bench adapter's example files and trial.py, read as text by the TypeScript side
  // of each cross-language claim (harbor/README.md, "Gates").
  { test: "packages/runtime/src/harbor-task-args.test.ts", reads: /^harbor\/nap_harbor\// },
  { test: "packages/sandbox/src/exec-channel.test.ts", reads: /^harbor\/nap_harbor\// },
  // Checks that the video the docs point at is in apps/web/public, that each page's edit link
  // names a file that exists, and that no docs source or stylesheet writes a colour literal.
  {
    test: "apps/web/src/docs/docs-page.test.tsx",
    reads: /^apps\/web\/public\/|^apps\/web\/src\/docs\//,
  },
  // Counts each section's `<Sub>` headings in its source, against what the outline found.
  { test: "apps/web/src/docs/outline.test.tsx", reads: /^apps\/web\/src\/docs\// },
  // Checks that the tests and the web build pin the same React Compiler release, and that no
  // browser code lives under app/ (which the tests leave uncompiled). It reads all of web's src.
  {
    test: "apps/web/src/testing/react-compiler.test.tsx",
    reads: /^(?:apps\/web\/)?package\.json$|^apps\/web\/src\//,
  },
  // Holds the landing demos' narrow-layout widths in demo.css and features.css to `narrowBelow`
  // in demo-window.tsx, so a frame's height is right before any script runs.
  {
    test: "apps/web/src/landing/demo-window.test.tsx",
    reads: /^apps\/web\/src\/landing\/(?:demo|features)\.css$/,
  },
  // Hashes DESKTOP_SOURCES (packages/sandbox/src/desktop-template.ts) and fails on any edit to one
  // until DESKTOP_BUILD is bumped. A superset of that list, held to it by test/check-changed.test.ts;
  // importing the list itself would load the E2B SDK on every run.
  {
    test: "packages/sandbox/src/desktop-build.test.ts",
    reads:
      /^packages\/sandbox\/(?:desktop\/|scripts\/desktop-|src\/desktop-)|^packages\/shared\/src\/ports\/(?:desktop-|sandbox-desktop)/,
  },
];
// Names too common to mean anything when a test mentions them: dozens of tests write their own
// package.json into a temporary directory. A change to a real one reaches its tests by typecheck
// and import instead.
const GENERIC_NAMES = new Set(["package.json"]);
// Biome's own configuration, and the ignore file it honours (`vcs.useIgnoreFile`), change what
// every file is checked against; so does a global file (bun.lock carries a Biome upgrade).
const BIOME_WIDE = new Set(["biome.json", ".gitignore"]);
// `integration` spends money and `types` is covered by each package's tsc, so neither is here;
// test files of those kinds are never chosen either. `computer` is chosen by name, not import.
const TEST_PROJECTS = ["unit", "web"];
const NEVER = /\.(?:integration|test-d)\./;

/** `dir/name` without any extension, so `a/x.ts`, `a/x.sh` and `a/x.computer.test.ts` agree. */
const stem = (path: string) => path.replace(/\.[^/]*$/, "");
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
// Code in another workspace is reached by import or listed in TREE_READERS. Anything else,
// JSON included, may also be read as text by a test that names it, so it is looked up by name.
const CODE = /\.[cm]?[jt]sx?$/;
const COMPUTER = /\.computer\.test\.ts$/;
const lookedUpByName = (path: string) => !CODE.test(path) && !GENERIC_NAMES.has(basename(path));

/** Which test files and projects a non-global change runs; see each rule's comment. */
function selectTests(
  input: PlanInput,
  touched: readonly Workspace[],
  runnable: readonly string[],
): { targets: string[]; computer: string[]; whole: string[] } {
  const paths = input.files.map((file) => file.path);
  const present = input.files.filter((file) => file.present).map((file) => file.path);
  // Every node test in a changed workspace runs, not only those importing the change: they
  // read their own package's components, fixtures and scripts as text, often through a helper.
  // Component tests (`.test.tsx`) reach what they render by import, which `related` follows,
  // and are left out: apps/web's take 50 s against its node tests' 1.4 s. Computer suites have
  // their own rule below. test/ always runs.
  const own = input.tests.filter(
    (test) =>
      test.startsWith("test/") ||
      (!test.endsWith(".tsx") &&
        !COMPUTER.test(test) &&
        touched.some(({ dir }) => test.startsWith(`${dir}/`))),
  );
  // A test elsewhere that names a changed file, or reads the tree it sits in, runs as well.
  const readers = [
    ...paths.filter(lookedUpByName).flatMap((path) => input.testsNaming[basename(path)] ?? []),
    ...TREE_READERS.filter(({ reads }) => paths.some((path) => reads.test(path))).map(
      ({ test }) => test,
    ),
  ];
  // A test that runs a script as a process exercises every workspace that script reaches.
  const changed = new Set(touched.map(({ name }) => name));
  const runners = Object.entries(input.processRunners)
    .filter(([, imports]) =>
      [...reach(input.workspaces, imports)].some((name) => changed.has(name)),
    )
    .map(([test]) => test);
  const chosen = [...own, ...readers, ...runners].filter((test) => !NEVER.test(test));
  // The computer suites spawn real processes and take a minute each, and one of them imports
  // most of the runtime: by import graph, a comment in packages/verify cost 71 s of the 140 s a
  // run took. So they run when they, the file they share a name with, or a file they read
  // changed. CI runs all.
  const stems = new Set(paths.map(stem));
  return {
    targets: [
      ...new Set([
        ...present.filter((path) => IMPORTABLE.test(path)),
        ...chosen.filter((test) => !COMPUTER.test(test)),
      ]),
    ],
    computer: [
      ...new Set([
        ...input.tests.filter((test) => COMPUTER.test(test) && stems.has(stem(test))),
        ...chosen.filter((test) => COMPUTER.test(test)),
      ]),
    ],
    // A setup file is loaded by every test in its project and imported by none of them, so a
    // change to one runs that whole project.
    whole: [...new Set(paths.flatMap((path) => input.setupFiles[path] ?? []))].filter((name) =>
      [...runnable, "computer"].includes(name),
    ),
  };
}

/** `names` and every workspace they depend on, directly or not. */
function reach(workspaces: readonly Workspace[], names: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const next of workspaces.find((workspace) => workspace.name === name)?.dependsOn ?? [])
      visit(next);
  };
  for (const name of names) visit(name);
  return seen;
}

export function planChecks(input: PlanInput): Plan {
  const present = input.files.filter((file) => file.present).map((file) => file.path);
  const paths = input.files.map((file) => file.path);
  if (paths.length === 0) return { steps: [], notes: [] };

  const notes: string[] = [];
  const steps: Step[] = [];
  const global = paths.some((path) => GLOBAL_FILES.has(path));

  if (global || paths.some((path) => BIOME_WIDE.has(path))) {
    steps.push({ name: "biome", commands: [["bunx", "biome", "check", "."]] });
  } else if (present.length > 0) {
    steps.push({
      name: "biome",
      commands: [
        [
          "bunx",
          "biome",
          "check",
          "--no-errors-on-unmatched",
          "--files-ignore-unknown=true",
          ...present,
        ],
      ],
    });
  }

  const touched = input.workspaces.filter((workspace) =>
    paths.some((path) => path.startsWith(`${workspace.dir}/`)),
  );
  const packages = touched.map((workspace) => workspace.name);
  if (global || packages.length > 0 || paths.some((path) => ROOT_PROGRAM.test(path))) {
    // `...pkg` is turbo's "this package and everything that depends on it", read from the same
    // package.json graph `bun run typecheck` walks. The root pass is ~2 s and imports from most
    // packages, so it runs whenever anything is typechecked at all.
    // turbo hashes only each package's own files, so a cached pass would replay after a change
    // to a root config such as tsconfig.base.json; --force reruns every package.
    const filters = global ? ["--force"] : packages.map((name) => `--filter=...${name}`);
    const turbo =
      global || packages.length > 0 ? [["bunx", "turbo", "run", "typecheck", ...filters]] : [];
    steps.push({ name: "typecheck", commands: [...turbo, ["bunx", "tsc", "--noEmit"]] });
  }

  const runnable = [...TEST_PROJECTS, ...(input.docker ? ["db"] : [])];
  const projects = runnable.flatMap((name) => ["--project", name]);
  if (!input.docker) notes.push("db tests skipped: Docker is not running. CI runs them.");
  if (global) {
    steps.push({
      name: "tests",
      commands: [["bunx", "vitest", "run", ...projects, "--project", "computer"]],
    });
  } else {
    const { targets, computer, whole } = selectTests(input, touched, runnable);
    // `related` runs each test file it is given and every test file whose imports reach a given
    // source file, across the listed projects. The runs go one after the other because parallel
    // vitest runs race on the same cache directory.
    steps.push({
      name: "tests",
      commands: [
        ["bunx", "vitest", "related", "--run", "--passWithNoTests", ...projects, ...targets],
        ...(computer.length > 0
          ? [["bunx", "vitest", "run", "--project", "computer", ...computer]]
          : []),
        ...(whole.length > 0
          ? [["bunx", "vitest", "run", ...whole.flatMap((name) => ["--project", name])]]
          : []),
      ],
    });
  }

  if (
    paths.some((path) => path.endsWith(".py") || /^harbor\/(pyproject\.toml|uv\.lock)$/.test(path))
  ) {
    steps.push({
      name: "python",
      // CI's two pytest runs: without Harbor, then with it, which is the only one reaching agent.py.
      commands: [
        ["bun", "run", "lint:py"],
        ["bun", "run", "test:py"],
        [
          "uv",
          "run",
          "--directory",
          "harbor",
          "--extra",
          "harbor",
          "--with",
          "pytest",
          "pytest",
          "-q",
        ],
      ],
    });
  }
  return { steps, notes };
}

const Args = z.union([
  z.tuple([z.literal("--staged")]).transform(() => ({ staged: true as const })),
  z.tuple([z.string().regex(/^[^-]/)]).transform(([ref]) => ({ staged: false as const, ref })),
  z.tuple([]).transform(() => ({ staged: false as const, ref: undefined })),
]);
const PackageJson = z.object({
  name: z.string(),
  workspaces: z.array(z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

/** Runs git; `-z` in `args` splits on NUL, so a path with a quote, tab or newline survives. */
function git(root: string, args: readonly string[], allowed: readonly number[] = [0]): string[] {
  const result = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  // An empty list from a failed git call would otherwise pass as "nothing changed".
  if (result.status === null || !allowed.includes(result.status)) {
    throw new Error(`git ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout.split(args.includes("-z") ? "\0" : "\n").filter(Boolean);
}

// Only the fields read here; vitest.config.ts is the one place the projects are defined.
const VitestConfig = z.object({
  test: z.object({
    projects: z.array(
      z.object({
        test: z.object({
          name: z.string(),
          setupFiles: z.union([z.string(), z.array(z.string())]).optional(),
          globalSetup: z.union([z.string(), z.array(z.string())]).optional(),
        }),
      }),
    ),
  }),
});

async function readSetupFiles(root: string): Promise<Record<string, string>> {
  const config = VitestConfig.parse(
    (await import(pathToFileURL(join(root, "vitest.config.ts")).href)).default,
  );
  return Object.fromEntries(
    config.test.projects.flatMap(({ test }) =>
      [test.setupFiles ?? [], test.globalSetup ?? []]
        .flat()
        .map((file) => [file.replace(/^\.\//, ""), test.name]),
    ),
  );
}

/** For each basename, the test files whose text contains it. `git grep` exits 1 on no match. */
function testsNaming(root: string, paths: readonly string[]): Record<string, string[]> {
  const names = [...new Set(paths.map(basename))];
  return Object.fromEntries(
    names.map((name) => [
      name,
      git(
        root,
        ["grep", "--untracked", "-z", "-l", "-F", "-e", name, "--", "*.test.ts", "*.test.tsx"],
        [0, 1],
      ),
    ]),
  );
}

function readWorkspaces(root: string): Workspace[] {
  const globs = PackageJson.parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
  return (globs.workspaces ?? []).flatMap((glob) => {
    // Every pattern here is `<dir>/*`; anything else would need a real glob matcher.
    if (!glob.endsWith("/*")) throw new Error(`unsupported workspace pattern: ${glob}`);
    const parent = glob.slice(0, -2);
    return readdirSync(join(root, parent))
      .map((entry) => `${parent}/${entry}`)
      .filter((dir) => existsSync(join(root, dir, "package.json")))
      .map((dir) => {
        const manifest = PackageJson.parse(
          JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")),
        );
        // Workspace packages are depended on as `workspace:*`; nothing else is.
        const dependsOn = Object.entries({
          ...manifest.dependencies,
          ...manifest.devDependencies,
        })
          .filter(([, version]) => version.startsWith("workspace:"))
          .map(([name]) => name);
        return { dir, name: manifest.name, dependsOn };
      });
  });
}

// A test that starts `bun` on a script, and the `.ts` paths it mentions. A heuristic over the
// test's text, pinned to the runners that exist by test/check-changed.test.ts.
const SPAWNS_BUN = /\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*"bun"/;
const TS_PATH = /["'`]([^"'`\s$]+\.ts)["'`]/g;
const NAP_IMPORT = /from "(@nap\/[^/"]+)/g;

/** For each test that runs a script with `bun`, the workspace packages that script imports. */
function readProcessRunners(root: string, tests: readonly string[]): Record<string, string[]> {
  const runners: Record<string, string[]> = {};
  for (const test of tests) {
    const text = readFileSync(join(root, test), "utf8");
    if (!SPAWNS_BUN.test(text)) continue;
    const scripts = [...text.matchAll(TS_PATH)]
      .map(([, path = ""]) =>
        // Written relative to the test (resolved through import.meta.url) or to the root.
        [join(dirname(test), path), path].find(
          (candidate) => !candidate.startsWith("..") && existsSync(join(root, candidate)),
        ),
      )
      .filter((path): path is string => path !== undefined && !path.endsWith(".test.ts"));
    const imports = scripts.flatMap((script) =>
      [...readFileSync(join(root, script), "utf8").matchAll(NAP_IMPORT)].map(
        ([, name = ""]) => name,
      ),
    );
    if (imports.length > 0) runners[test] = [...new Set(imports)];
  }
  return runners;
}

function changedFiles(
  root: string,
  args: z.infer<typeof Args>,
): { label: string; files: string[] } {
  if (args.staged) {
    return {
      label: "staged",
      files: git(root, ["diff", "--cached", "--name-only", "--no-renames", "-z"]),
    };
  }
  const ref =
    args.ref ??
    (git(root, ["branch", "-r", "--list", "origin/main"]).length > 0 ? "origin/main" : "main");
  const [base] = git(root, ["merge-base", "HEAD", ref]);
  if (base === undefined) throw new Error(`no merge base with ${ref}`);
  // Diffing the working tree against the base counts committed, staged and unstaged edits alike;
  // untracked files are listed separately. --no-renames lists a rename as both of its paths.
  const files = new Set([
    ...git(root, ["diff", "--name-only", "--no-renames", "-z", base]),
    ...git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return { label: `since ${base.slice(0, 12)} (merge base with ${ref})`, files: [...files].sort() };
}

type StepResult = { name: string; ok: boolean; seconds: number };

// Ctrl-C reaches the whole process group, but a SIGTERM sent to this process alone (a hook
// runner's timeout, say) would leave turbo and vitest running; the entrypoint passes it on.
const running = new Set<ChildProcess>();

function runStep(root: string, step: Step): Promise<StepResult & { output: string }> {
  const started = Date.now();
  // Output is piped so parallel steps do not interleave; keep the colours a terminal would get.
  const env = process.stdout.isTTY ? { ...process.env, FORCE_COLOR: "1" } : process.env;
  let output = "";
  const run = async (): Promise<boolean> => {
    let ok = true;
    for (const [command, ...args] of step.commands) {
      if (command === undefined) continue;
      output += `$ ${[command, ...args].join(" ")}\n`;
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(command, args, { cwd: root, env });
        running.add(child);
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          output += chunk;
        });
        child.on("error", (error) => {
          output += `${error.message}\n`;
          resolve(1);
        });
        child.on("close", (exitCode, signal) => {
          running.delete(child);
          // Killed rather than failed, by the OOM killer on a loaded machine for instance.
          if (signal !== null) output += `killed by ${signal}\n`;
          resolve(exitCode);
        });
      });
      if (code !== 0) ok = false;
    }
    return ok;
  };
  return run().then((ok) => ({
    name: step.name,
    ok,
    seconds: (Date.now() - started) / 1000,
    output,
  }));
}

/** Everything `planChecks` needs about the repo at `root`, for these changed files. */
export async function readInputs(
  root: string,
  files: readonly string[],
  docker: boolean,
): Promise<PlanInput> {
  const tests = git(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "*.test.ts",
    "*.test.tsx",
  ]).filter((path) => existsSync(join(root, path)));
  return {
    files: files.map((path) => ({ path, present: existsSync(join(root, path)) })),
    workspaces: readWorkspaces(root),
    docker,
    tests,
    // Only files `related` cannot follow are looked up; the planner decides which of these count.
    testsNaming: testsNaming(root, files.filter(lookedUpByName)),
    setupFiles: await readSetupFiles(root),
    processRunners: readProcessRunners(root, tests),
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = Args.safeParse(argv);
  if (!parsed.success) {
    console.error("usage: bun run check:changed [<ref> | --staged]");
    return 2;
  }
  const [root] = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  if (root === undefined) throw new Error("not inside a git repository");
  const { label, files } = changedFiles(root, parsed.data);
  if (files.length === 0) {
    console.log(`check:changed: no changes ${label}.`);
    return 0;
  }
  console.log(`check:changed: ${files.length} files ${label}`);

  const plan = planChecks(
    await readInputs(
      root,
      files,
      // On a loaded machine `docker info` can take several seconds to answer while Docker is up.
      spawnSync("docker", ["info"], { stdio: "ignore", timeout: 30_000 }).status === 0,
    ),
  );
  for (const step of plan.steps) console.log(`  running ${step.name}`);

  // The steps share no state, so they run side by side; each prints when it finishes.
  const results = await Promise.all(
    plan.steps.map((step) =>
      runStep(root, step).then((result) => {
        console.log(
          `\n> ${result.name}  ${result.ok ? "pass" : "FAIL"}  ${result.seconds.toFixed(1)}s`,
        );
        if (!result.ok) console.log(result.output.trimEnd());
        return result;
      }),
    ),
  );

  console.log("\ncheck:changed summary");
  for (const result of results) {
    console.log(`  ${result.ok ? "pass" : "FAIL"}  ${result.name}  ${result.seconds.toFixed(1)}s`);
  }
  for (const note of plan.notes) console.log(`  ${note}`);
  console.log("  CI runs every suite in full regardless.");
  return results.every((result) => result.ok) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.once("SIGTERM", () => {
    for (const child of running) child.kill("SIGTERM");
    process.exit(143);
  });
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`check:changed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    },
  );
}
