import type { RepositoryJob } from "@nap/shared/github-protocol";

/**
 * The thread details card's arithmetic: where it sits, which job it describes, and what its git
 * row offers. Pure, so every threshold can be pinned without a layout engine.
 *
 * Adapted from T3 Code's `threadDetailsCardLayout.ts` and `GitActionsControl.logic.ts` (MIT — see
 * apps/web/THIRD_PARTY_NOTICES.md).
 */

export const DETAILS_CARD_GAP = 12;
export const DETAILS_CARD_WIDTH = 280;
/** What the conversation keeps between its own edge and the card's. */
const DETAILS_CARD_CLEARANCE = 32;
const LANE_PADDING = 48;
const MIN_CHAT_WIDTH = 640;
const MIN_CARD_HEIGHT = 160;

/**
 * Inline when the card can float beside the conversation and still leave it a readable lane;
 * otherwise a popover the header toggle opens over it. The container is the canvas below the
 * header, the same box the card is placed in.
 */
export function detailsPresentation(container: {
  width: number;
  height: number;
}): "inline" | "popover" {
  const x = container.width - DETAILS_CARD_WIDTH - DETAILS_CARD_GAP;
  if (x - DETAILS_CARD_CLEARANCE - LANE_PADDING < MIN_CHAT_WIDTH) return "popover";
  if (container.height - DETAILS_CARD_GAP * 2 < MIN_CARD_HEIGHT) return "popover";
  return "inline";
}

/** The server lists jobs newest first; PR refreshes can touch an older job at any time. */
export function currentJob(jobs: readonly RepositoryJob[]): RepositoryJob | null {
  return jobs[0] ?? null;
}

/**
 * Whether asking for a publication would do anything. The same rule the pull requests panel
 * applies to its own button: a merged or closed pull request is finished, and a job still
 * working has nothing verified to push.
 */
export function canPublish(job: RepositoryJob): boolean {
  return (
    (job.publishState === "ready" ||
      job.publishState === "publishing" ||
      job.publishState === "failed" ||
      job.publishState === "published") &&
    job.pullRequestState !== "closed" &&
    job.pullRequestState !== "merged"
  );
}

export type QuickAction =
  | { kind: "publish"; label: string }
  | { kind: "open"; label: string; url: string }
  | { kind: "progress"; label: string }
  | { kind: "hint"; label: string; hint: string };

/**
 * The split row's primary half. T3 Code names the action by what it would do to the branch; nap
 * commits after every turn, so "commit" here is the publication pushing the work nap verified,
 * and the label follows T3's: the pull request is part of the action until one is open.
 */
export function quickAction(job: RepositoryJob | null, requesting: boolean): QuickAction {
  if (requesting || job?.publishState === "publishing")
    return { kind: "progress", label: "Publishing…" };
  if (job === null)
    return {
      kind: "hint",
      label: "Commit, push & PR",
      hint: "Send a task in chat to start work on a dedicated branch.",
    };
  const label = job.pullRequestState === "open" ? "Commit & push" : "Commit, push & PR";
  if (job.publishState === "working")
    return { kind: "hint", label, hint: "nap is still working on this branch." };
  if (job.pullRequestUrl !== null && (job.publishState === "published" || !canPublish(job)))
    return { kind: "open", label: "View PR", url: job.pullRequestUrl };
  if (!canPublish(job))
    return { kind: "hint", label, hint: "This branch's pull request is closed." };
  return { kind: "publish", label };
}

export function diffTotals(files: readonly { additions: number; deletions: number }[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions };
}

const DIFF_COUNT_FORMAT = new Intl.NumberFormat();

export function formatDiffCount(count: number): string {
  return DIFF_COUNT_FORMAT.format(count);
}

export function branchUrl(fullName: string, branch: string): string {
  return `https://github.com/${fullName}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;
}
