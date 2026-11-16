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
  realpathSync,
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
/** How long a cancelled install has to stop on the signal it was sent before it is killed. */
const KILL_GRACE_MS = 5_000;

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
  // Real paths, so a symlinked spelling of the main checkout is still recognised as itself —
  // otherwise its own env symlinks would be replaced by links to themselves.
  if (realpathSync(main) === realpathSync(worktree)) return [];
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
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else: alive all the same.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The PID a marker's text names, when that process is alive and is not this one. */
function livePidIn(text: string): number | null {
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid) ? pid : null;
}

function readMarker(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The PID a `setup-running` marker names, when that process is still alive. */
export function liveSetupPid(markerDir: string): number | null {
  const text = readMarker(join(markerDir, RUNNING));
  return text === null ? null : livePidIn(text);
}

/** Whether this process became the setup running here, and if not, the live setup that is. */
export type Claim = { claimed: true } | { claimed: false; holder: number | null };

/**
 * Makes this process the setup running in `markerDir` by writing its PID to the running marker
 * only if there is none: one atomic step, so of two setups started together exactly one wins.
 * A marker whose setup died is taken over, but removed only while it still says what was read —
 * removing it unread would let a setup delete the marker another had just written, and both would
 * install. `holder` is null when another setup claimed the marker in the same instant.
 */
export function claimSetup(markerDir: string): Claim {
  const marker = join(markerDir, RUNNING);
  mkdirSync(markerDir, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(marker, `${process.pid}\n`, { flag: "wx" });
      return { claimed: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const text = readMarker(marker);
    if (text === null) continue;
    const holder = livePidIn(text);
    if (holder !== null) return { claimed: false, holder };
    if (readMarker(marker) === text) rmSync(marker, { force: true });
  }
  return { claimed: false, holder: liveSetupPid(markerDir) };
}

async function main(): Promise<void> {
  const worktree = resolve(import.meta.dirname, "..");
  const markerDir = join(worktree, MARKER_DIR);

  // Two setups at once would race each other's install; the second leaves the markers alone.
  const claim = claimSetup(markerDir);
  if (!claim.claimed) {
    const holder = claim.holder === null ? "another setup" : `PID ${claim.holder}`;
    process.stderr.write(`Setup is already running here as ${holder}; wait for it.\n`);
    process.exit(1);
  }
  // Running first, then clear the old outcome, so there is never a moment with no marker at all —
  // which an agent reads as "setup never ran" and answers with an install of its own.
  rmSync(join(markerDir, DONE), { force: true });
  rmSync(join(markerDir, FAILED), { force: true });

  let install: ReturnType<typeof spawn> | undefined;
  // `bun install` exits on a signal without stopping the install script it is running, and that
  // script keeps the install's output open and outlives the cancel (measured, bun 1.4.2). So the
  // install gets a process group of its own, and stopping it signals the whole group.
  const stopInstall = (signal: NodeJS.Signals) => {
    if (install?.pid === undefined) return;
    try {
      process.kill(-install.pid, signal);
    } catch {
      // The group is already gone.
    }
  };
  let failure = "";
  process.on("uncaughtExceptionMonitor", (error) => {
    failure = error.stack ?? String(error);
  });
  // Any exit a handler can see leaves done or failed in place of running, or an agent would wait
  // forever. Only a signal with no handler here (SIGKILL, of this process or of its whole group;
  // SIGUSR2) or a crash of the runtime escapes it, leaving a running marker whose PID is dead and
  // an install, in its own group, that runs on.
  process.on("exit", (code) => {
    if (code === 0) writeFileSync(join(markerDir, DONE), "");
    else writeFileSync(join(markerDir, FAILED), `Setup exited with code ${code}.\n${failure}\n`);
    rmSync(join(markerDir, RUNNING), { force: true });
  });

  // A cancelled setup passes the signal to the install and fails once that has stopped, so no
  // marker appears while the install can still be writing node_modules.
  let cancelled: NodeJS.Signals | undefined;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      cancelled = signal;
      if (install) {
        stopInstall(signal);
        // An install script that ignores the signal would hold the install open, and an agent
        // waiting on this live PID, for ever.
        setTimeout(() => stopInstall("SIGKILL"), KILL_GRACE_MS).unref();
      } else {
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
    detached: true,
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
