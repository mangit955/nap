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
 * The fold is here rather than in that hook because this is its only reader — the rule the hook
 * states: a view more than one pane needs is derived above them, so the two cannot disagree,
 * and everything else stays where it is read. The transcript beside it is folded the same way.
 *
 * The wording is `job-summary.ts`'s. This file is only what it looks like.
 */

import type { VerifiedCheck } from "@nap/shared/events";
import { foldJobs, type JobPhase } from "@nap/shared/job-state";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { useMemo } from "react";
import { type JobSummary, jobSummary } from "./job-summary.ts";

export function JobStrip({ events }: { events: readonly StoredEvent[] }) {
  // Keyed on the array rather than its length, the way the workspace's other folds are: the log
  // is append-only and a new array arrives for every event, so identity changes exactly when
  // the answer could have.
  const summary = useMemo(() => jobSummary(foldJobs(events)), [events]);
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
      </div>

      {summary.checks.length > 0 && (
        <ul aria-label="Checks" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {summary.checks.map((check) => (
            <li key={check.name} className="flex items-center gap-1.5">
              <Dot outcome={check.outcome} />
              <span className="font-mono text-[11px] text-ink-2">{check.name}</span>
              {/*
                The outcome as a word, beside the colour rather than instead of it. Red and grey
                are the same thing to a reader who cannot tell them apart, and `absent` and
                `failed` are the pair it is most expensive to confuse — one is a check the
                project never declared, the other is a check that said no. The domain's own
                three words, said as they are: `CONTEXT.md` picked them for exactly this.
              */}
              <span className="font-mono text-[11px] text-muted">{check.outcome}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="text-[11.5px] text-muted leading-snug">{summary.state}</p>
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
        className={`size-1.5 rounded-full ${summary.open ? "animate-pulse bg-accent" : toneOf(summary.phase)}`}
      />
      {summary.phaseLabel}
    </p>
  );
}

/**
 * A closed job's colour.
 *
 * Only the two outcomes that leave work undone are marked. The palette has one alarm colour and
 * no success colour on purpose — `globals.css` — so a verified job is a neutral dot and the
 * word beside it, which is what a green tick would have said anyway.
 */
function toneOf(phase: JobPhase): string {
  if (phase === "exhausted" || phase === "abandoned") return "bg-danger";
  return "bg-line-strong";
}

/**
 * The check's outcome as a mark. Failed is the only one that gets the alarm colour; passed and
 * absent are told apart by fill against outline, and in words beside it either way — the two
 * are the pair it is most expensive to confuse, and colour alone cannot carry that.
 */
function Dot({ outcome }: { outcome: VerifiedCheck["outcome"] }) {
  const tone =
    outcome === "failed"
      ? "bg-danger"
      : outcome === "passed"
        ? "bg-ink-2"
        : "border border-line-strong";

  return <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${tone}`} />;
}
