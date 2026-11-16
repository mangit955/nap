// Runs CI's checks on what this branch changed, in seconds rather than the minute the full
// suites take: Biome over the changed files, typecheck of the packages they live in and every
// package that depends on those, the tests that import the changed files, and the Python gates
// when Python changed. CI still runs everything; this is the inner loop and the pre-commit hook.
//
//   bun run check:changed            changes since the merge base with origin/main, committed or not
//   bun run check:changed <ref>      changes since the merge base with <ref>
//   bun run check:changed --staged   only what the next commit holds (the pre-commit hook)
//
// The decision of which steps run for which files is `planChecks`, a pure function tested in
// test/check-changed.test.ts. Everything below it only gathers its inputs and runs its output.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export type Workspace = { readonly name: string; readonly dir: string };
export type ChangedFile = { readonly path: string; readonly present: boolean };
/** Commands run one after another; a step fails at the first that exits non-zero. */
export type Step = { readonly name: string; readonly commands: readonly (readonly string[])[] };
export type Plan = { readonly steps: readonly Step[]; readonly notes: readonly string[] };

export type PlanInput = {
  readonly files: readonly ChangedFile[];
  readonly workspaces: readonly Workspace[];
  /** Whether a Docker daemon answers: the `db` project starts a Postgres container. */
  readonly docker: boolean;
  /** `test/*.test.ts`: always run, because they read the source as text and no import reaches them. */
  readonly repoTests: readonly string[];
  /** Every `*.computer.test.ts` in the repo, which run only when they or their namesake changed. */
  readonly computerTests: readonly string[];
  /**
   * For each changed file's basename, the test files whose source names it. A test that reads a
   * script, a fixture or a migration as text names it; no import reaches it, so `related` cannot.
   */
  readonly testsNaming: Readonly<Record<string, readonly string[]>>;
  /** Each test project's setup and global-setup files, from vitest.config.ts, keyed by path. */
  readonly setupFiles: Readonly<Record<string, string>>;
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
// Tests that read whole trees as text without naming the files in them, so neither the import
// graph nor `testsNaming` can find them. Any other test that reads a file names it.
const TREE_READERS = [
  // Every Python file under harbor/ is checked against the TypeScript it mirrors.
  { test: "apps/napbench/src/harbor-agreement.test.ts", reads: /^harbor\// },
  // Walks every component each page reaches, looking for landing-only font classes.
  { test: "apps/web/src/app/font-placement.test.ts", reads: /^apps\/web\/src\/.*\.tsx$/ },
];
// Names too common to mean anything when a test mentions them: dozens of tests write their own
// package.json into a temporary directory. A change to a real one reaches its tests by typecheck
// and import instead.
const GENERIC_NAMES = new Set(["package.json"]);
// Biome's own configuration changes what every file is checked against.
const BIOME_CONFIG = "biome.json";
// `integration` spends money and `types` is covered by each package's tsc, so neither is here.
// `computer` is chosen by name rather than by import, below.
const TEST_PROJECTS = ["unit", "web"];

/** `dir/name` without any extension, so `a/x.ts`, `a/x.sh` and `a/x.computer.test.ts` agree. */
const stem = (path: string) => path.replace(/\.[^/]*$/, "");
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function planChecks(input: PlanInput): Plan {
  const present = input.files.filter((file) => file.present).map((file) => file.path);
  const paths = input.files.map((file) => file.path);
  if (paths.length === 0) return { steps: [], notes: [] };

  const notes: string[] = [];
  const steps: Step[] = [];
  const global = paths.some((path) => GLOBAL_FILES.has(path));

  if (paths.includes(BIOME_CONFIG)) {
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

  const packages = input.workspaces
    .filter((workspace) => paths.some((path) => path.startsWith(`${workspace.dir}/`)))
    .map((workspace) => workspace.name);
  if (global || packages.length > 0 || paths.some((path) => ROOT_PROGRAM.test(path))) {
    // `...pkg` is turbo's "this package and everything that depends on it", read from the same
    // package.json graph `bun run typecheck` walks. The root pass is ~2 s and imports from most
    // packages, so it runs whenever anything is typechecked at all.
    const filters = global ? [] : packages.map((name) => `--filter=...${name}`);
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
    // A test that names a changed file, or reads the tree it sits in, runs as if it had changed.
    const readers = [
      ...paths
        .filter((path) => !IMPORTABLE.test(path) && !GENERIC_NAMES.has(basename(path)))
        .flatMap((path) => input.testsNaming[basename(path)] ?? []),
      ...TREE_READERS.filter(({ reads }) => paths.some((path) => reads.test(path))).map(
        ({ test }) => test,
      ),
    ].filter((test) => !/\.(?:integration|test-d)\./.test(test));
    const targets = [
      ...new Set([
        ...present.filter((path) => IMPORTABLE.test(path)),
        ...readers.filter((test) => !test.endsWith(".computer.test.ts")),
        ...input.repoTests,
      ]),
    ];
    // The computer suites spawn real processes and take a minute each, and one of them imports
    // most of the runtime: by import graph, a comment in packages/verify cost 71 s of the 140 s a
    // run took. So they run when they, the file they share a name with, or a file they name
    // changed. CI runs all.
    const stems = new Set(paths.map(stem));
    const computer = [
      ...new Set([
        ...input.computerTests.filter((test) => stems.has(stem(test))),
        ...readers.filter((test) => test.endsWith(".computer.test.ts")),
      ]),
    ];
    // A setup file is loaded by every test in its project and imported by none of them, so a
    // change to one runs that whole project.
    const whole = [...new Set(paths.flatMap((path) => input.setupFiles[path] ?? []))].filter(
      (name) => [...runnable, "computer"].includes(name),
    );
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
      commands: [
        ["bun", "run", "lint:py"],
        ["bun", "run", "test:py"],
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
const PackageJson = z.object({ name: z.string(), workspaces: z.array(z.string()).optional() });

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
  const names = [...new Set(paths.map((path) => path.slice(path.lastIndexOf("/") + 1)))];
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
      .map((dir) => ({
        dir,
        name: PackageJson.parse(JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")))
          .name,
      }));
  });
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

function runStep(root: string, step: Step): Promise<StepResult & { output: string }> {
  const started = Date.now();
  // Output is piped so parallel steps do not interleave; keep the colours a terminal would get.
  const env = process.stdout.isTTY ? { ...process.env, FORCE_COLOR: "1" } : process.env;
  let output = "";
  const run = async (): Promise<boolean> => {
    for (const [command, ...args] of step.commands) {
      if (command === undefined) continue;
      output += `$ ${[command, ...args].join(" ")}\n`;
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(command, args, { cwd: root, env });
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
        child.on("close", resolve);
      });
      if (code !== 0) return false;
    }
    return true;
  };
  return run().then((ok) => ({
    name: step.name,
    ok,
    seconds: (Date.now() - started) / 1000,
    output,
  }));
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

  const plan = planChecks({
    files: files.map((path) => ({ path, present: existsSync(join(root, path)) })),
    workspaces: readWorkspaces(root),
    docker: spawnSync("docker", ["info"], { stdio: "ignore", timeout: 5_000 }).status === 0,
    repoTests: readdirSync(join(root, "test"))
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => `test/${name}`),
    computerTests: git(root, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "*.computer.test.ts",
    ]).filter((path) => existsSync(join(root, path))),
    // Only files `related` cannot follow are looked up; the planner decides which of these count.
    testsNaming: testsNaming(
      root,
      files.filter((path) => !IMPORTABLE.test(path)),
    ),
    setupFiles: await readSetupFiles(root),
  });

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
