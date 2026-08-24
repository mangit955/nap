"use client";

/**
 * One card above the transcript, saying what was decided while nobody was watching.
 *
 * It sits over the seam from `unseen.ts` and answers the question the seam only points at: the
 * marker says *where* your reading stopped, and this says *what came of it* — the sentence the
 * name of this product is a promise about.
 *
 * **Above the scroller rather than inside it**, for the reason the `JobStrip` above is: a card
 * that scrolls away with the conversation is one somebody has to go looking for during the exact
 * minute it matters. The seam stays where it is either way — this is not a replacement for it,
 * and dismissing this leaves the transcript exactly as it was.
 *
 * **Dismissible, and dismissing drops you at the live state.** The card is a summary of a
 * finished thing, so the one control it needs is the one that says "read". What it does to the
 * transcript is the pane's business, not this file's.
 *
 * Whether it appears at all, and every word in it, is `unseen-summary.ts`'s — including the fact
 * that most returns show none. This file is only what it looks like.
 */

import type { UnseenSummary } from "./unseen-summary.ts";

export function UnseenCard({ card, onDismiss }: { card: UnseenSummary; onDismiss: () => void }) {
  return (
    <section
      // Named by its own heading rather than by an `aria-label` repeating it: the sentence is
      // worth seeing, and a label that duplicates visible text is a second copy to keep true.
      aria-labelledby="unseen-card-heading"
      className="flex shrink-0 flex-col gap-1.5 border-accent/40 border-b bg-accent/5 px-4 py-2.5"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${card.failed ? "bg-danger" : "bg-accent"}`}
        />
        <h2
          id="unseen-card-heading"
          className="font-medium font-mono text-[11px] text-accent-ink uppercase tracking-wide"
        >
          While you were away
        </h2>

        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto shrink-0 rounded-chip px-1.5 py-0.5 font-mono text-[11px] text-muted transition-colors hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        >
          Dismiss
        </button>
      </div>

      {/*
        Absent rather than empty when the log cannot say what was asked — a turn that failed
        before a job could open has no objective, and a blank line where a sentence goes reads
        as something that failed to load.

        Two lines on screen and the whole sentence in the DOM, the same clip the history uses:
        a real objective runs to five or six lines in a 440px column.
      */}
      {card.objective !== null && (
        <p className="line-clamp-2 text-[12px] text-ink leading-snug">{card.objective}</p>
      )}

      <p className="text-[11.5px] text-ink-2 leading-snug">{card.outcome}</p>

      {(card.repairs !== null || card.checkpoint !== null) && (
        <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
          {card.repairs !== null && <span>{card.repairs}</span>}
          {card.checkpoint !== null && (
            <span className="font-mono">Checkpoint · {card.checkpoint}</span>
          )}
        </p>
      )}
    </section>
  );
}
