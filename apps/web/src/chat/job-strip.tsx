"use client";

/**
 * One strip above the conversation, saying where the job stands.
 *
 * The loop this app is built around — a turn makes a claim, the project's own checks arbitrate
 * it, a failure prompts a repair — is invisible in a transcript. What a reader sees there is
 * the model working, then working again, and nothing that says why. So the four facts that
 * make it legible are lifted out and held still: what the job is doing, what the checks said,
 * how many repairs it has spent, and whether the project is currently in a state something has
 * checked.
 *
 * **Status, not chronology.** Every one of those is answered again by the next event, which is
 * why they belong in a strip that is overwritten rather than in a log that grows — and why the
 * transcript deliberately draws nothing for `job.*` and `verification.*` (`transcript.ts`).
 *
 * **No new pane and no new route.** The events already arrive through the one subscription the
 * workspace has (`useSessionLog`), and a second surface for four lines of text would be a
 * second thing to keep in sync with the log.
 *
 * **And the history expands it rather than becoming that second surface** — same fold, same
 * subscription, and none of the preview's screen real estate. What the expansion lists is
 * *jobs*, failures included, for a reason worth reading in `job-history.tsx` before assuming it
 * should be called Checkpoints. The control that opens it is the newest checkpoint rather than
 * a chevron: a strip that expands is a strip most people never click, so the affordance is the
 * fact somebody wanted anyway.
 *
 * The fold is here rather than in that hook because this is its only reader — the rule the hook
 * states: a view more than one pane needs is derived above them, so the two cannot disagree,
 * and everything else stays where it is read. The transcript beside it is folded the same way.
 *
 * The wording is `job-summary.ts`'s. This file is only what it looks like.
 */

import { foldJobs } from "@nap/shared/job-state";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { useMemo, useState } from "react";
import { historyLabel, jobHistory } from "./job-history.ts";
import { JobHistory } from "./job-history.tsx";
import { CheckList, phaseTone } from "./job-marks.tsx";
import { type JobSummary, jobSummary } from "./job-summary.ts";

export function JobStrip({ events }: { events: readonly StoredEvent[] }) {
  // Keyed on the array rather than its length, the way the workspace's other folds are: the log
  // is append-only and a new array arrives for every event, so identity changes exactly when
  // the answer could have.
  const state = useMemo(() => foldJobs(events), [events]);
  // One fold, three readers: the strip describes the newest job, the history lists them all,
  // and the label on the control is a fact about the session. Folding again per reader would
  // let two of them disagree about the same log.
  const summary = useMemo(() => jobSummary(state), [state]);
  const entries = useMemo(() => jobHistory(state), [state]);
  const label = historyLabel(state);
  const [open, setOpen] = useState(false);

  // A project nobody has asked anything of has no job and no status. An empty strip over an
  // empty transcript would be chrome describing nothing.
  if (summary === null) return null;

  return (
    <section
      aria-label="Job status"
      className="flex shrink-0 flex-col gap-1.5 border-edge border-b bg-panel/60 px-4 py-2.5"
    >
      <div className="flex items-center gap-2">
        <Phase summary={summary} />

        {summary.attemptsLabel !== null && (
          <span className="font-mono text-[11px] text-muted">· {summary.attemptsLabel}</span>
        )}

        {label !== null && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="ml-auto shrink-0 rounded-chip px-1.5 py-0.5 font-mono text-[11px] text-muted transition-colors hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          >
            {label}
            <span aria-hidden="true" className="pl-1.5">
              {open ? "▴" : "▾"}
            </span>
          </button>
        )}
      </div>

      <CheckList checks={summary.checks} />

      <p className="text-[11.5px] text-muted leading-snug">{summary.state}</p>

      {open && <JobHistory entries={entries} />}
    </section>
  );
}

/**
 * What the job is doing, in a live region.
 *
 * `role="status"` rather than a plain span: the phase changing is the one thing here that
 * happens on its own while somebody is reading, and it is exactly what a person who cannot see
 * the strip would otherwise have to poll for. Polite, so it waits for a gap rather than cutting
 * across the transcript's own announcements.
 */
function Phase({ summary }: { summary: JobSummary }) {
  return (
    <p role="status" className="flex items-center gap-1.5 font-medium text-[12px] text-ink">
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${summary.open ? "animate-pulse bg-accent" : phaseTone(summary.phase)}`}
      />
      {summary.phaseLabel}
    </p>
  );
}
