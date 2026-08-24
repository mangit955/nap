/**
 * What the strip expands into: every job this session has run, in the words the strip uses.
 *
 * **It is a list of jobs, not a list of checkpoints, and that is the decision worth reading.**
 * `job.checkpointed` is emitted from exactly one place in the runtime, on the success path — so
 * a history built from checkpoints is a history with every failure deleted from it: four green
 * ticks, and no record that the thing asked for at 14:32 was attempted, repaired three times
 * and abandoned. The panel exists to answer *"what happened?"*, and a list of only successes
 * cannot. So one entry per job; `verified` entries carry the sha, `exhausted` and `abandoned`
 * entries appear beside them, marked.
 *
 * **"Checkpoint" keeps its strong meaning**, reserved for the verified-commit line *inside* an
 * entry exactly as `CONTEXT.md` defines it. That is why the panel is not called Checkpoints,
 * and why the two words can sit on the same screen without either losing its edge.
 *
 * Pure, and the wording lives here rather than in the component for the reason `job-summary.ts`
 * gives: these sentences are claims about whether somebody's work survived, and a claim is
 * worth a test. It shares that module's vocabulary rather than growing a second one — a job
 * that reads `Out of repairs` in the strip must not read `Exhausted` one line below it.
 */

import type { VerifiedCheck } from "@nap/shared/events";
import {
  isJobFailed,
  isJobOpen,
  type JobPhase,
  type JobState,
  type SessionJobs,
} from "@nap/shared/job-state";
import { PHASE_LABELS, repairsLabel } from "./job-summary.ts";

/** Git's own abbreviation, so a sha here is the one somebody would type. */
const SHORT_SHA = 7;

export type JobHistoryEntry = {
  jobId: string;
  /**
   * Which job of the session this was, counting from the first one *in this window*.
   *
   * It does not move when a newer job opens, which is what makes it usable for pointing at a
   * row — but it is a position in the folded log rather than an identity, so a client that
   * joined mid-session numbers from what it can see. That is the same windowing `foldJobs`
   * documents: a job whose opening is outside the window is not folded at all, so there is no
   * count of the invisible ones to offset by. The `jobId` is the stable handle.
   */
  ordinal: number;
  /** What was asked, as the prompt that opened the job put it. The entry's title. */
  objective: string;
  phase: JobPhase;
  phaseLabel: string;
  /** Still running: the one entry whose contents can still change. */
  open: boolean;
  /** Closed with work left undone — `exhausted` or `abandoned`. What earns a row its mark. */
  failed: boolean;
  /** The job's last verification, or empty if none answered. */
  checks: readonly VerifiedCheck[];
  /** Repairs spent, in the strip's words, or `null` when none were. */
  attemptsLabel: string | null;
  /** The sha this job checkpointed, abbreviated — `null` if it reached none. */
  checkpoint: string | null;
  /** Files the job's turns touched, counted once each, or `null` when it changed nothing. */
  filesLabel: string | null;
  /** When the job opened, in full. ISO 8601, for a `<time>` element's `dateTime`. */
  startedAt: string;
  /** The same moment as a clock reads it, in the viewer's timezone. */
  clock: string;
};

/**
 * Every job, newest first.
 *
 * The newest is also what the strip above is describing, and it is listed here anyway: the
 * strip answers "where does this stand" and the list answers "what has happened", and a list
 * that silently omits the thing that just happened is a list somebody has to reconcile by
 * counting.
 */
export function jobHistory(state: SessionJobs): readonly JobHistoryEntry[] {
  return state.jobs.map(toEntry).reverse();
}

function toEntry(job: JobState, index: number): JobHistoryEntry {
  return {
    jobId: job.jobId,
    ordinal: index + 1,
    objective: job.objective,
    phase: job.phase,
    phaseLabel: PHASE_LABELS[job.phase],
    open: isJobOpen(job),
    failed: isJobFailed(job),
    checks: job.checks,
    attemptsLabel: repairsLabel(job.attemptsUsed),
    checkpoint: job.checkpointSha === null ? null : job.checkpointSha.slice(0, SHORT_SHA),
    filesLabel: filesLabel(job.filesChanged),
    startedAt: job.startedAt,
    clock: clockTime(job.startedAt),
  };
}

/**
 * What the strip carries on its face once there is a history behind it.
 *
 * A strip that expands is a strip most people never click, so the control is not a chevron
 * labelled "History" — it is the fact people want most, which happens also to be the way in.
 * `null` while a session has run one job: expanding into a list of one describes nothing the
 * strip is not already showing, and a control that does nothing is worse than no control.
 *
 * It counts **checkpoints**, not jobs, and the word is used in its strong sense: a job that
 * failed produced none and must not advance the number. When nothing has been checkpointed yet
 * there is no such fact to show, so it falls back to saying how much there is to see.
 */
export function historyLabel(state: SessionJobs): string | null {
  if (state.jobs.length < 2) return null;

  const checkpointed = state.jobs.filter((job) => job.checkpointSha !== null);
  const newest = checkpointed.at(-1);
  if (newest?.checkpointSha == null) return `${state.jobs.length} jobs`;

  return `Checkpoint ${checkpointed.length} · ${newest.checkpointSha.slice(0, SHORT_SHA)}`;
}

function filesLabel(count: number): string | null {
  if (count === 0) return null;
  return `${count} ${count === 1 ? "file" : "files"} changed`;
}

/**
 * The time of day, and nothing more.
 *
 * A relative "4 minutes ago" would need a clock and a rerender to stay true, and would go stale
 * in a tab left open — which is exactly the tab this panel is for. The full instant is on the
 * entry's `startedAt` and reaches the reader through the `<time>` element's `dateTime`, so the
 * date is not lost, only unsaid.
 */
function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
