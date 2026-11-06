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
import { shellQuote } from "@nap/shared/shell";
import { decodeRepositoryBundle, encodeRepositoryBundle } from "./git-bundle.ts";
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
  signal?: AbortSignal | undefined;
};

/**
 * Where a snapshot's bundle is written inside the sandbox, on the way out and on the way in.
 *
 * Exported for the fakes that stand in for `git bundle create`: they leave the bundle here.
 */
export const BUNDLE_PATH = "/tmp/nap-snapshot.bundle";

/**
 * Committer identity, passed per command rather than written to the repository's config.
 *
 * Set globally, it would be invisible state that these helpers silently depend on, and a
 * restored or differently built image would fail with git's "please tell me who you are".
 */
const IDENTITY = "-c user.email=agent@nap.dev -c user.name=Nap";

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
  if (options?.signal?.aborted) return cancelled();
  const cwd = options?.cwd === undefined ? TEMPLATE_WORKDIR : shellQuote(options.cwd);
  const result = await manager.exec(sandboxId, `cd ${cwd} && ${command}`);
  return options?.signal?.aborted ? cancelled() : result;
}

function cancelled(): Result<never, SandboxError> {
  return { ok: false, error: { code: "exec_failed", message: "The Git operation was cancelled." } };
}

/**
 * What the commit script prints, in place of a sha, when the tree had nothing to commit.
 *
 * Exported for the fakes that stand in for the script: they answer it with this or a sha.
 */
export const NOTHING_TO_COMMIT = "nap: nothing to commit";

/** A full object id, SHA-1 or SHA-256. Anything else on the last line is not a commit. */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The whole of `commitAll`, as one command, so a turn's commit is one round trip and not four.
 *
 * `diff --quiet --cached` exits 0 when the index matches HEAD, and that is the one case that
 * commits nothing; any other exit commits, so a diff that itself failed lets the commit say why.
 * Staging and committing are joined with `&&` so either failing fails the script, and the sha is
 * read only after the commit, on the last line, where nothing git printed before it can shadow it.
 *
 * Spelled `--all`, `--quiet --cached`, `--verify` and `--message=` on purpose. Fakes answer commands
 * by pattern, and tests across the repo still hold patterns for the four commands this replaced —
 * `/git rev-parse HEAD/` most of all, which also answers `currentSha`. Different spellings mean
 * none of those can answer this script by accident and pass a test that exercised nothing.
 */
export function commitScript(message: string): string {
  return (
    "git add --all && " +
    `if git diff --quiet --cached; then echo ${shellQuote(NOTHING_TO_COMMIT)}; ` +
    `else git ${IDENTITY} commit --message=${shellQuote(message)} && git rev-parse --verify HEAD; fi`
  );
}

/**
 * Stages everything and commits it, or does nothing if there is nothing to commit.
 *
 * A clean tree is an ordinary outcome, not a failure: plenty of turns only read files, and
 * failing those would turn "the agent answered a question" into "the turn errored". A commit
 * that fails is a failure, never "nothing to commit": the script exits non-zero, and only the
 * marker it prints on purpose reads as a clean tree.
 */
export async function commitAll(
  manager: SandboxManager,
  sandboxId: string,
  message: string,
  options?: GitOptions,
): Promise<Result<CommitResult, SandboxError>> {
  const committed = await git(manager, sandboxId, commitScript(message), options);
  if (!committed.ok) return committed;

  const last = committed.value.trimEnd().split("\n").at(-1)?.trim() ?? "";
  if (last === NOTHING_TO_COMMIT) return { ok: true, value: { committed: false, sha: null } };
  if (OBJECT_ID.test(last)) return { ok: true, value: { committed: true, sha: last } };
  return {
    ok: false,
    error: {
      code: "exec_failed",
      message: `the commit finished without saying what it committed: ${JSON.stringify(last)}`,
    },
  };
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

/** What `workspaceState` hands back. Opaque: the only thing to do with one is compare it. */
export type WorkspaceState = string;

/**
 * Which commit is checked out and how the working tree differs from it, as one comparable value.
 *
 * For something that does not hold the session's lease to ask whether the workspace has changed
 * since it last looked — a sha alone misses a following turn that has edited files and not yet
 * committed them. A tree that was already dirty is fine: it is compared, never required to be
 * clean, because a project's own checks can leave untracked files behind.
 *
 * **`--no-optional-locks` is what makes this safe to run beside a turn, and it is not a nicety.**
 * A plain `git status` refreshes the index and takes `index.lock` to do it, and a turn's `git add`
 * meeting that lock fails — which fails the commit, which fails the turn. Measured against a real
 * repository: 4 `git add`s in 300 failed beside a plain status, none beside this one.
 */
export async function workspaceState(
  manager: SandboxManager,
  sandboxId: string,
  options?: GitOptions,
): Promise<Result<WorkspaceState, SandboxError>> {
  return await git(
    manager,
    sandboxId,
    "git rev-parse HEAD && git --no-optional-locks status --porcelain",
    options,
  );
}

/**
 * The whole repository as a git bundle — a single file holding every ref and all history.
 *
 * One command writes the bundle and prints which ref or commit HEAD is, and the bundle is then
 * read back as a file, byte for byte. It used to be read back through that command's output as
 * base64: a third larger, streamed through the command channel, on every turn. It is still the
 * whole history every time, deliberately — a restore that needed a chain of earlier bundles would
 * depend on every one of them surviving, which is the thing a snapshot exists not to depend on.
 *
 * `rev-parse --verify` rather than `rev-parse HEAD`, so a fake answering `currentSha` by pattern
 * cannot answer this too — see `commitScript`.
 */
export async function bundle(
  manager: SandboxManager,
  sandboxId: string,
  options?: GitOptions,
): Promise<Result<Uint8Array, SandboxError>> {
  // HEAD is explicit because detached commits need not be reachable from a named ref.
  const head = await git(
    manager,
    sandboxId,
    `{ git symbolic-ref -q HEAD || git rev-parse --verify HEAD; } && git bundle create ${BUNDLE_PATH} --all HEAD`,
    options,
  );
  if (!head.ok) return head;

  if (options?.signal?.aborted) return cancelled();
  const bytes = await manager.readFileBytes(sandboxId, BUNDLE_PATH);
  if (!bytes.ok) return bytes;

  // The first line: git writes its progress to stderr, so nothing should follow, but nothing that
  // did could change which ref was checked out.
  const ref = head.value.trimStart().split("\n")[0]?.trim() ?? "";
  return { ok: true, value: encodeRepositoryBundle(bytes.value, ref) };
}

/**
 * Replaces the repository and working tree with the contents of a bundle.
 *
 * Builds and validates fresh Git metadata before replacing the old repository. Every ref
 * survives, and the envelope disambiguates branches whose tips happen to be the same commit.
 */
export async function restoreBundle(
  manager: SandboxManager,
  sandboxId: string,
  bytes: Uint8Array,
  options?: GitOptions,
): Promise<Result<void, SandboxError>> {
  if (options?.signal?.aborted) return cancelled();
  const decodedBundle = decodeRepositoryBundle(bytes);
  if (!decodedBundle.ok) return decodedBundle;
  const written = await manager.writeFileBytes(sandboxId, BUNDLE_PATH, decodedBundle.value.bundle);
  if (!written.ok) return written;

  const directory = "/tmp/nap-snapshot.git";
  const fetched = await git(
    manager,
    sandboxId,
    `git bundle verify ${BUNDLE_PATH} && rm -rf ${directory} && git -c core.hooksPath=/dev/null clone --mirror ${BUNDLE_PATH} ${directory}`,
    options,
  );
  if (!fetched.ok) return fetched;

  const head = decodedBundle.value.head;
  if (head !== null) {
    const selected = await git(
      manager,
      sandboxId,
      `git --git-dir=${directory} rev-parse --verify ${shellQuote(`${head}^{commit}`)} && ` +
        (head.startsWith("refs/heads/")
          ? `git check-ref-format ${shellQuote(head)} && git --git-dir=${directory} symbolic-ref HEAD ${shellQuote(head)}`
          : `git --git-dir=${directory} update-ref --no-deref HEAD ${shellQuote(head)}`),
      options,
    );
    if (!selected.ok) return selected;
  }

  const configured = await git(
    manager,
    sandboxId,
    `git --git-dir=${directory} config core.bare false && git --git-dir=${directory} config core.hooksPath /dev/null && git --git-dir=${directory} config --remove-section remote.origin`,
    options,
  );
  if (!configured.ok) return configured;

  // Validate everything before replacing the template's Git metadata. Keep its index until
  // reset so files tracked only by the template are removed from the working tree too.
  const reset = await git(
    manager,
    sandboxId,
    `(test ! -f .git/index || cp .git/index ${directory}/index) && rm -rf .git && mv ${directory} .git && git reset --hard HEAD`,
    options,
  );
  if (!reset.ok) return reset;

  // No `-x`: ignored files must survive. node_modules is gitignored and baked into the
  // image, and deleting it would turn a one-second project open into a full reinstall.
  const cleaned = await git(manager, sandboxId, "git clean -fd", options);
  if (!cleaned.ok) return cleaned;

  return { ok: true, value: undefined };
}
