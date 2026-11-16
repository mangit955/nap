// Prepares a fresh git worktree of this repository: installs dependencies (which also installs
// the lefthook git hooks through `prepare`), links the main checkout's gitignored env files in,
// and leaves a marker in `.t3/` saying whether that is still running, finished or failed. T3 Code
// runs it when it creates a worktree, through `t3.json`, and starts the agent without waiting for
// it, so the markers are how an agent knows whether to wait. Running it by hand in any checkout is
// safe, and so is running it twice.
//
// It runs before `bun install`, so it may import Node built-ins only.
import { execFileSync, spawn } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * The gitignored env files a worktree needs from the main checkout: every file a runtime here
 * loads on its own — Bun at the root and in `apps/api`, Next.js in `apps/web` — whether or not
 * it exists today. A missing one is skipped, so naming it costs nothing, while a file left off
 * this list would leave every worktree silently without it.
 */
export const ENV_FILES = [
  ".env",
  ".env.local",
  "apps/api/.env",
  "apps/api/.env.local",
  "apps/web/.env",
  "apps/web/.env.local",
] as const;

export const MARKER_DIR = ".t3";
export const RUNNING = "setup-running";
export const DONE = "setup-done";
export const FAILED = "setup-failed";

/**
 * The main checkout, from `git worktree list --porcelain`. Git always lists it first, whichever
 * worktree asks, which is what makes this work for a plain `git worktree add` as well as for
 * T3 Code. Null when the repository is bare, since then there is no checkout to take files from.
 */
export function mainCheckoutFrom(porcelain: string): string | null {
  const [first = ""] = porcelain.split(/\n\n/);
  const lines = first.split("\n");
  if (lines.includes("bare")) return null;
  const worktree = lines.find((line) => line.startsWith("worktree "));
  return worktree ? worktree.slice("worktree ".length) : null;
}

export type LinkOutcome = { file: string; result: "linked" | "missing" | "kept" };

/**
 * Symlinks each env file that exists in `main` into `worktree`, and returns what it did per file.
 *
 * A link rather than a copy, so the main checkout stays the one place a key lives: rotating it
 * there reaches every worktree, and no worktree keeps a stale credential. Only a symlink is ever
 * replaced. A real file in the worktree is the worktree's own and is kept, which is also why
 * running this twice changes nothing. Nothing is written outside `worktree`.
 */
export function linkEnvFiles(
  main: string,
  worktree: string,
  files: readonly string[] = ENV_FILES,
): LinkOutcome[] {
  if (resolve(main) === resolve(worktree)) return [];
  return files.map((file) => {
    const source = join(main, file);
    const target = join(worktree, file);
    if (relative(worktree, target).startsWith("..")) {
      throw new Error(`Env file ${file} resolves outside the worktree.`);
    }
    if (!statSync(source, { throwIfNoEntry: false })?.isFile()) return { file, result: "missing" };
    const existing = lstatSync(target, { throwIfNoEntry: false });
    if (existing && !existing.isSymbolicLink()) return { file, result: "kept" };
    if (existing) rmSync(target);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target);
    return { file, result: "linked" };
  });
}

/**
 * `env` without git's own variables. Started from a git hook, this process inherits `GIT_DIR` and
 * `GIT_INDEX_FILE`, and a git it starts — directly, or through `lefthook install` — would act on
 * that repository instead of the one it is in.
 */
export function withoutGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("GIT_")));
}

/** The last `lines` lines of `output`, trimmed — what a failure marker keeps of an install. */
export function tailOf(output: string, lines = 30): string {
  return output.trimEnd().split("\n").slice(-lines).join("\n");
}

/** Whether a process with this PID is alive, which is what makes a `setup-running` marker live. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else: alive all the same.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The PID a `setup-running` marker names, when that process is still alive. */
export function liveSetupPid(markerDir: string): number | null {
  let text: string;
  try {
    text = readFileSync(join(markerDir, RUNNING), "utf8");
  } catch {
    return null;
  }
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid) ? pid : null;
}

async function main(): Promise<void> {
  const worktree = resolve(import.meta.dirname, "..");
  const markerDir = join(worktree, MARKER_DIR);

  // Two setups at once would race each other's install; the second leaves the markers alone.
  const running = liveSetupPid(markerDir);
  if (running !== null) {
    process.stderr.write(`Setup is already running here as PID ${running}; wait for it.\n`);
    process.exit(1);
  }

  rmSync(join(markerDir, DONE), { force: true });
  rmSync(join(markerDir, FAILED), { force: true });
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(join(markerDir, RUNNING), `${process.pid}\n`);

  let failure = "";
  process.on("uncaughtExceptionMonitor", (error) => {
    failure = error.stack ?? String(error);
  });
  // Every way out leaves exactly one of done or failed, or an agent would wait forever.
  process.on("exit", (code) => {
    if (code === 0) writeFileSync(join(markerDir, DONE), "");
    else writeFileSync(join(markerDir, FAILED), `Setup exited with code ${code}.\n${failure}\n`);
    rmSync(join(markerDir, RUNNING), { force: true });
  });

  // A cancelled setup passes the signal to the install and fails once that has stopped, so no
  // marker appears while the install can still be writing node_modules.
  let cancelled: NodeJS.Signals | undefined;
  let install: ReturnType<typeof spawn> | undefined;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      cancelled = signal;
      if (install) install.kill(signal);
      else {
        failure = `Cancelled by ${signal}.`;
        process.exit(1);
      }
    });
  }

  // A lockfile that disagrees with package.json fails here instead of being rewritten, which
  // would leave the new worktree dirty before anyone touched it.
  const env = withoutGitEnv(process.env);
  install = spawn(process.execPath, ["install", "--frozen-lockfile"], {
    cwd: worktree,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const [source, sink] of [
    [install.stdout, process.stdout],
    [install.stderr, process.stderr],
  ] as const) {
    source?.setEncoding("utf8");
    source?.on("data", (chunk: string) => {
      sink.write(chunk);
      output = (output + chunk).slice(-8_000);
    });
  }
  const status = await new Promise<number | null>((done) => install?.on("close", done));
  install = undefined;
  if (status !== 0 || cancelled) {
    failure = cancelled ? `Cancelled by ${cancelled}.` : tailOf(output);
    process.exit(status || 1);
  }

  // After the install, not before: `bun install` loads a checkout's env files into the
  // environment of every install script it runs, whatever flags it is given. Linking them first
  // would hand the main checkout's credentials to a fresh worktree's first install for nothing.
  const porcelain = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: worktree,
    env,
    encoding: "utf8",
  });
  const mainCheckout = mainCheckoutFrom(porcelain);
  if (mainCheckout === null) {
    process.stdout.write("No main checkout (bare repository); not linking env files.\n");
  } else if (resolve(mainCheckout) === worktree) {
    process.stdout.write("This is the main checkout; its env files are its own.\n");
  } else {
    // Names and outcomes only. The contents of an env file are never read here.
    for (const { file, result } of linkEnvFiles(mainCheckout, worktree)) {
      process.stdout.write(`env ${file}: ${result}\n`);
    }
  }
}

if (import.meta.main) await main();
