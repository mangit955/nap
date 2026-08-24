"use client";

/**
 * The small marks a job wears — its checks' outcomes, and its own — in one place because two
 * surfaces draw them.
 *
 * The strip says where the current job stands; the history below it says the same of every past
 * job. Left as two copies they would drift, and the thing that would drift is the pair `absent`
 * and `failed` — one is a check the project never declared, the other is a check that said no,
 * and they are the most expensive pair here to confuse.
 *
 * Which is why an outcome is a **word** beside the mark rather than a colour instead of one.
 * Red and grey are the same thing to a reader who cannot tell them apart. The domain's own
 * three words, said as they are: `CONTEXT.md` picked them for exactly this.
 */

import type { VerifiedCheck } from "@nap/shared/events";
import { isJobFailed, type JobPhase } from "@nap/shared/job-state";

export function CheckList({
  checks,
  label = "Checks",
}: {
  checks: readonly VerifiedCheck[];
  /**
   * The list's accessible name. Defaulted, and overridden by the history so that several lists
   * of checks on one screen can be told apart by the row they belong to.
   */
  label?: string;
}) {
  if (checks.length === 0) return null;

  return (
    <ul aria-label={label} className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {checks.map((check) => (
        <li key={check.name} className="flex items-center gap-1.5">
          <CheckDot outcome={check.outcome} />
          <span className="font-mono text-[11px] text-ink-2">{check.name}</span>
          <span className="font-mono text-[11px] text-muted">{check.outcome}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The check's outcome as a mark. Failed is the only one that gets the alarm colour; passed and
 * absent are told apart by fill against outline, and in words beside it either way.
 */
function CheckDot({ outcome }: { outcome: VerifiedCheck["outcome"] }) {
  const tone =
    outcome === "failed"
      ? "bg-danger"
      : outcome === "passed"
        ? "bg-ink-2"
        : "border border-line-strong";

  return <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${tone}`} />;
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
