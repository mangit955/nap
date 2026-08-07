/**
 * Git operations on a project, driven entirely through `SandboxManager.exec`.
 *
 * Every project is a git repository from the moment it is created — the template bakes in
 * `git init` and one commit — and two things need to act on it: a turn commits its own
 * changes, and a project is snapshotted by bundling the repository and restored by
 * unbundling it. Both go through here rather than shelling out at their call sites, so
 * the exact command sequences live in one tested place.
 *
 * These are plain functions over a `SandboxManager` rather than methods on it. Git is a
 * convention this project happens to use, not part of what a sandbox *is*, and the port
 * stays small enough for a second implementation to be worth writing.
 */

import type { SandboxError, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { TEMPLATE_WORKDIR } from "./template.ts";

export type CommitResult = {
  /** False when the working tree was already clean; not an error. */
  committed: boolean;
  /** The new commit, or null when nothing was committed. */
  sha: string | null;
};

export type GitOptions = {
  /** Defaults to the project directory the template creates. */
  cwd?: string;
};

/** Where the bundle and its base64 transport land inside the sandbox. */
const BUNDLE_PATH = "/tmp/nap-snapshot.bundle";
const BUNDLE_B64_PATH = "/tmp/nap-snapshot.bundle.b64";

/**
 * Committer identity, passed per command rather than written to the repository's config.
 *
 * Set globally, it would be invisible state that these helpers silently depend on, and a
 * restored or differently built image would fail with git's "please tell me who you are".
 */
const IDENTITY = "-c user.email=agent@nap.dev -c user.name=Nap";

/**
 * Renders a string as a single literal shell argument.
 *
 * Commit messages are written by a model, so they arrive containing whatever the model
 * felt like emitting — quotes, backticks, `$(…)`, newlines. Interpolated raw into a
 * command line that is about to run inside the user's sandbox, that is command injection,
 * and the attacker is the text the user typed into a chat box.
 *
 * Single quotes suppress every form of shell expansion; the only character that needs
 * handling is a single quote itself, which cannot appear inside them. The POSIX-portable
 * escape is to close the string, emit a backslash-escaped quote, and reopen it.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Runs a command in the project directory, turning a non-zero exit into a typed error. */
async function git(
  manager: SandboxManager,
  sandboxId: string,
  command: string,
  options: GitOptions | undefined,
): Promise<Result<string, SandboxError>> {
  const result = await run(manager, sandboxId, command, options);
  if (!result.ok) return result;

  if (result.value.exitCode !== 0) {
    return {
      ok: false,
      error: {
        code: "exec_failed",
        message: `git command failed (exit ${result.value.exitCode}): ${command}\n${result.value.stderr}`,
      },
    };
  }
  return { ok: true, value: result.value.stdout };
}

/** As `git`, but hands back the exit code instead of treating it as failure. */
async function run(
  manager: SandboxManager,
  sandboxId: string,
  command: string,
  options: GitOptions | undefined,
): Promise<Result<{ exitCode: number; stdout: string; stderr: string }, SandboxError>> {
  return manager.exec(sandboxId, `cd ${options?.cwd ?? TEMPLATE_WORKDIR} && ${command}`);
}

/**
 * Stages everything and commits it, or does nothing if there is nothing to commit.
 *
 * A clean tree is an ordinary outcome, not a failure: plenty of turns only read files, and
 * failing those would turn "the agent answered a question" into "the turn errored".
 */
export async function commitAll(
  manager: SandboxManager,
  sandboxId: string,
  message: string,
  options?: GitOptions,
): Promise<Result<CommitResult, SandboxError>> {
  const staged = await git(manager, sandboxId, "git add -A", options);
  if (!staged.ok) return staged;

  // `--quiet` makes the exit code the whole answer: 0 means the index matches HEAD, so
  // there is nothing to commit. Readable as data only because the sandbox layer reports
  // non-zero exits rather than throwing them.
  const changes = await run(manager, sandboxId, "git diff --cached --quiet", options);
  if (!changes.ok) return changes;
  if (changes.value.exitCode === 0) return { ok: true, value: { committed: false, sha: null } };

  const committed = await git(
    manager,
    sandboxId,
    `git ${IDENTITY} commit -m ${shellQuote(message)}`,
    options,
  );
  if (!committed.ok) return committed;

  const sha = await currentSha(manager, sandboxId, options);
  if (!sha.ok) return sha;

  return { ok: true, value: { committed: true, sha: sha.value } };
}

/** The commit currently checked out. A repository with no commits is an error, not "". */
export async function currentSha(
  manager: SandboxManager,
  sandboxId: string,
  options?: GitOptions,
): Promise<Result<string, SandboxError>> {
  const result = await git(manager, sandboxId, "git rev-parse HEAD", options);
  if (!result.ok) return result;
  return { ok: true, value: result.value.trim() };
}

/**
 * The whole repository as a git bundle — a single file holding every ref and all history.
 *
 * Carried out as base64 because a bundle is binary and both `exec` stdout and `readFile`
 * are text. That costs a third in size and puts the payload in a command's output, which
 * is fine for projects of the size this builds and is worth revisiting if they grow.
 */
export async function bundle(
  manager: SandboxManager,
  sandboxId: string,
  options?: GitOptions,
): Promise<Result<Uint8Array, SandboxError>> {
  // `--all`, so branches other than the current one survive the round trip.
  const result = await git(
    manager,
    sandboxId,
    `git bundle create ${BUNDLE_PATH} --all && base64 -w0 ${BUNDLE_PATH}`,
    options,
  );
  if (!result.ok) return result;

  // Tolerant of wrapping: -w0 asks for one line, but not every base64 honours it.
  const encoded = result.value.replaceAll(/\s/g, "");
  return { ok: true, value: Uint8Array.from(Buffer.from(encoded, "base64")) };
}

/**
 * Replaces the repository and working tree with the contents of a bundle.
 *
 * Fetches into `FETCH_HEAD` and resets onto it rather than fetching a branch by name,
 * because git refuses to update the branch that is currently checked out.
 */
export async function restoreBundle(
  manager: SandboxManager,
  sandboxId: string,
  bytes: Uint8Array,
  options?: GitOptions,
): Promise<Result<void, SandboxError>> {
  const written = await manager.writeFile(
    sandboxId,
    BUNDLE_B64_PATH,
    Buffer.from(bytes).toString("base64"),
  );
  if (!written.ok) return written;

  const decoded = await git(
    manager,
    sandboxId,
    `base64 -d ${BUNDLE_B64_PATH} > ${BUNDLE_PATH}`,
    options,
  );
  if (!decoded.ok) return decoded;

  const fetched = await git(manager, sandboxId, `git fetch ${BUNDLE_PATH}`, options);
  if (!fetched.ok) return fetched;

  const reset = await git(manager, sandboxId, "git reset --hard FETCH_HEAD", options);
  if (!reset.ok) return reset;

  // No `-x`: ignored files must survive. node_modules is gitignored and baked into the
  // image, and deleting it would turn a one-second project open into a full reinstall.
  const cleaned = await git(manager, sandboxId, "git clean -fd", options);
  if (!cleaned.ok) return cleaned;

  return { ok: true, value: undefined };
}
