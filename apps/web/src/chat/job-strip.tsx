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
 * The fold arrives already done, from `useSessionLog`, under the rule that hook states: a view
 * more than one pane needs is derived above them so the two cannot disagree. This *was* the only
 * reader; the bar across the top now mirrors the phase, so that collapsing this pane does not
 * take it off the screen — and that bar owns the announcement, which is why the phase below is
 * drawn and not spoken.
 *
 * The wording is `job-summary.ts`'s. This file is only what it looks like.
 */

import { useMemo, useState } from "react";
import { historyLabel, jobHistory } from "./job-history.ts";
import { JobHistory } from "./job-history.tsx";
import { CheckList, PhaseDot } from "./job-marks.tsx";
import type { JobSummary, SessionJobView } from "./job-summary.ts";

export function JobStrip({ jobs }: { jobs: SessionJobView }) {
  // One fold and one description, arriving from above: the strip says where the newest job
  // stands, the history lists them all, the label on the control is a fact about the session,
  // and the bar overhead says the phase again for the times this pane is collapsed.
  const { state, summary } = jobs;
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
 * What the job is doing — drawn, not announced.
 *
 * The phase changing is the one thing here that happens on its own while somebody is reading, so
 * it is announced; but by the copy in the workspace bar, which is never unmounted. A live region
 * here as well would say it twice while the chat is open and nothing at all once it is
 * collapsed, since this pane goes with it. See `workspace-header.tsx`.
 */
function Phase({ summary }: { summary: JobSummary }) {
  return (
    <p className="flex items-center gap-1.5 font-medium text-[12px] text-ink">
      <PhaseDot job={summary} />
      {summary.phaseLabel}
    </p>
  );
}
