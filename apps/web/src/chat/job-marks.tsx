"use client";

/**
 * The mark a job wears in the workspace bar: pulsing while it can still change, toned once it
 * cannot.
 */

import { isJobFailed, type JobPhase } from "@nap/shared/job-state";
import type { JobSummary } from "./job-summary.ts";

export function PhaseDot({ job }: { job: JobSummary }) {
  return (
    <span
      aria-hidden="true"
      className={`size-1.5 shrink-0 rounded-full ${job.open ? "animate-pulse bg-accent" : phaseTone(job.phase)}`}
    />
  );
}

/**
 * A closed job's colour.
 *
 * Only the two outcomes that leave work undone are marked. The palette has one alarm colour and
 * no success colour on purpose — `globals.css` — so a verified job is a neutral dot and the
 * word beside it, which is what a green tick would have said anyway.
 */
export function phaseTone(phase: JobPhase): string {
  return isJobFailed({ phase }) ? "bg-danger" : "bg-line-strong";
}
