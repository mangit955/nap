import {
  COMPACTION_HISTORY_DIR,
  COMPACTION_HISTORY_FORMAT,
  compactionBoundaries,
  compactionHistoryPath,
  renderCompactionHistory,
} from "@nap/context/compaction-history";
import type { NapEvent } from "@nap/shared/events";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";

/**
 * Keeps a session's compaction history in its sandbox: the file the summary points the agent at.
 *
 * Here because writing to a sandbox is a turn's side effect, which is the runtime's job; the
 * context engine renders the text and decides what the model is told, and has no side effects
 * on the sandbox.
 *
 * The file is a cache of the event log and is treated like one. A sandbox loses it whenever it
 * is replaced, because snapshots carry the project's git history and nothing outside it, so a
 * reopened project comes back without one. Every turn of a compacted session therefore checks
 * before building context, and regenerates the file from events when it is missing or behind.
 */
export type CompactionHistoryFile = {
  readonly path: string;
  /**
   * Writes the file for these boundaries and records which ones it holds. `false` when the
   * file could not be written, and the agent must not be told it exists.
   */
  write(history: readonly NapEvent[], boundaries: readonly number[]): Promise<boolean>;
  /**
   * Makes the file match the log's committed checkpoints. Resolves to its path, or `undefined`
   * when the session has nothing compacted or the sandbox would not take the write.
   */
  sync(history: readonly NapEvent[]): Promise<string | undefined>;
};

/** What the record says while the file is being replaced. No `describe` result can equal it. */
const WRITING = "writing\n";

export function compactionHistoryFile(options: {
  sandbox: SandboxManager;
  sandboxId: string;
  sessionId: string;
}): CompactionHistoryFile {
  const { sandbox, sandboxId, sessionId } = options;
  const path = compactionHistoryPath(sessionId);
  // A small record of what the file holds, beside it, so the per-turn check reads a few bytes
  // instead of a transcript. A dot file because it is bookkeeping, not something to search.
  const record = `${COMPACTION_HISTORY_DIR}/.${sessionId}.parts`;
  const describe = (boundaries: readonly number[]): string =>
    `format ${COMPACTION_HISTORY_FORMAT}\nparts ${boundaries.join(",")}\n`;

  const write = async (history: readonly NapEvent[], boundaries: readonly number[]) => {
    // Cleared first, because a write that fails may have left part of a file behind, and the
    // record from before it would still vouch for the result if the compaction then came to
    // nothing and the log went on saying what that record says. If this fails too, the file
    // is left exactly as the record describes it.
    const cleared = await sandbox.writeFile(sandboxId, record, WRITING);
    if (!cleared.ok) return false;
    const written = await sandbox.writeFile(
      sandboxId,
      path,
      renderCompactionHistory(history, sessionId, boundaries),
    );
    if (!written.ok) return false;
    // Recorded only after the file is in place. A record that fails to write costs one
    // regeneration on the next turn; one that ran ahead of its file would cost a wrong answer.
    await sandbox.writeFile(sandboxId, record, describe(boundaries));
    return true;
  };

  return {
    path,
    write,
    async sync(history) {
      const boundaries = compactionBoundaries(history);
      if (boundaries.length === 0) return undefined;
      const [recorded, listed] = await Promise.all([
        sandbox.readFile(sandboxId, record),
        sandbox.listFiles(sandboxId, COMPACTION_HISTORY_DIR),
      ]);
      // Exact equality, not "at least": a compaction writes its part before the event that
      // commits it, so a file can hold a part the log later failed to commit.
      const current =
        recorded.ok &&
        recorded.value === describe(boundaries) &&
        listed.ok &&
        listed.value.some((node) => node.path === path);
      if (current) return path;
      return (await write(history, boundaries)) ? path : undefined;
    },
  };
}
