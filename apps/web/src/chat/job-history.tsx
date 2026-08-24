"use client";

/**
 * Every job this session has run, under the strip that describes the newest one.
 *
 * **A list of jobs, not a list of checkpoints** — failures get a row here too, marked, and
 * "Checkpoint" is reserved for the verified-commit line *inside* one. That is the answer to
 * "why is this not called Checkpoints", and the argument for it is `job-history.ts`'s: read it
 * before changing what a row says.
 *
 * **It expands the strip rather than becoming a pane.** Same fold, same subscription, same
 * component family, and none of the preview's screen real estate. A third workbench tab would
 * put history in direct competition with the preview for the dominant half of the window, and
 * the preview is the thing being watched.
 *
 * The wording is `job-history.ts`'s. This file is only what it looks like.
 */

import type { JobHistoryEntry } from "./job-history.ts";
import { CheckList, phaseTone } from "./job-marks.tsx";

export function JobHistory({ entries }: { entries: readonly JobHistoryEntry[] }) {
  if (entries.length === 0) return null;

  return (
    /*
      Its own scroller, and the cap is not cosmetic. The strip sits *above* the transcript's
      scroller and does not shrink, so an expansion the length of its contents pushes the
      conversation off the bottom of the pane — measured against the kept session, four jobs of
      real objectives run past 1000px in a 440px column. The list scrolls; the chat stays.
    */
    <ul
      aria-label="Job history"
      className="nap-scroll flex max-h-[45vh] flex-col gap-2 overflow-y-auto pt-0.5"
    >
      {entries.map((entry) => (
        <li
          key={entry.jobId}
          className="flex flex-col gap-1 border-edge border-l pl-2.5 first:border-line-strong"
        >
          <div className="flex items-baseline gap-2">
            <span className="shrink-0 font-mono text-[11px] text-muted">Job {entry.ordinal}</span>
            {/*
              Two lines on screen, the whole sentence in the DOM. A real objective runs to five
              or six lines in this column — the kept session's shortest is three — and four of
              them stacked is a wall nobody reads. `line-clamp` is a visual clip and not a
              truncation: the text is all there, so a screen reader gets the sentence somebody
              actually wrote and only the eye is spared it.
            */}
            <p className="line-clamp-2 min-w-0 flex-1 text-[12px] text-ink leading-snug">
              {entry.objective}
            </p>
            <Phase entry={entry} />
          </div>

          <CheckList checks={entry.checks} label={`Checks for job ${entry.ordinal}`} />

          <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
            {entry.checkpoint !== null && (
              <span className="font-mono">Checkpoint · {entry.checkpoint}</span>
            )}
            {entry.attemptsLabel !== null && <span>{entry.attemptsLabel}</span>}
            {entry.filesLabel !== null && <span>{entry.filesLabel}</span>}
            {/*
              The clock for reading, the instant for anything that needs to be exact. A row is
              "11:09" on screen and says nothing about which day; `dateTime` is where that lives.
            */}
            <time dateTime={entry.startedAt} className="font-mono">
              {entry.clock}
            </time>
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * How the job ended, or that it has not.
 *
 * Not a live region, unlike the strip's: this is a record of what happened, and a list of past
 * jobs announcing itself would say the same sentence the strip is already announcing.
 */
function Phase({ entry }: { entry: JobHistoryEntry }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-2">
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${entry.open ? "animate-pulse bg-accent" : phaseTone(entry.phase)}`}
      />
      {entry.phaseLabel}
    </span>
  );
}
