/**
 * Folding a run of tool calls into one thing on screen.
 *
 * This is the *second* fold. `transcript.ts` turns the event log into items — one per thing that
 * happened — and this turns those items into what is drawn. They are separate because they
 * answer different questions: the first is about the log's shape and has to be right about
 * out-of-order results and reconnections, and this one is about how much of that a reader should
 * be shown at once.
 *
 * The answer is: not much. A turn is twenty tool calls and three sentences, and twenty mono
 * lines is a wall the eye slides off. So a run of adjacent steps becomes one disclosure — "8
 * actions" — and the prose between runs stays where it was, because that is the model saying
 * what it just did and what it is about to do. Folding across a sentence would file the
 * explanation under the wrong half of the work.
 *
 * Pure, like the fold above it, so the interesting cases are checkable without rendering.
 */

import type { FileChange, StepStatus, TranscriptItem } from "./transcript.ts";

type Step = Extract<TranscriptItem, { kind: "step" }>;

export type StepGroup = {
  kind: "steps";
  key: number;
  steps: Step[];
  /**
   * Changes that arrived with no step open to hang them on, which happens to a client that
   * connected between a tool call and its result. They belong with the work around them rather
   * than as their own block splitting one card in two.
   */
  files: FileChange[];
  /** What the card's face says: failed beats running beats done. */
  status: StepStatus;
  failed: number;
};

/** Everything the transcript draws: the items that pass through, and the groups. */
export type DisplayItem = Exclude<TranscriptItem, { kind: "step" } | { kind: "files" }> | StepGroup;

export function groupSteps(items: readonly TranscriptItem[]): DisplayItem[] {
  const out: DisplayItem[] = [];
  /** The group still being filled, or nothing if the last item was not part of a run. */
  let open: StepGroup | undefined;

  for (const item of items) {
    if (item.kind !== "step" && item.kind !== "files") {
      // Anything else ends the run — see the header: prose divides work into what came before
      // it and what came after.
      open = undefined;
      out.push(item);
      continue;
    }

    if (open === undefined) {
      // **The group keeps the key it opened with**, which is the same rule the thinking passage
      // follows and load-bearing for the same reason: React renders the card under this key, so
      // keying it to the newest member instead would remount it every time a tool result
      // arrived — springing a card shut in the middle of a turn somebody was reading.
      open = { kind: "steps", key: item.key, steps: [], files: [], status: "ok", failed: 0 };
      out.push(open);
    }

    if (item.kind === "files") open.files.push(...item.files);
    else open.steps.push(item);
  }

  // Derived after the fact rather than maintained as each member lands: a status is a fact about
  // the whole group, and updating it incrementally is two places for the precedence to live.
  for (const group of out) {
    if (group.kind === "steps") {
      group.failed = group.steps.filter((step) => step.status === "failed").length;
      group.status = summarise(group.steps);
    }
  }

  return out;
}

/**
 * What a group of steps amounts to.
 *
 * Failure wins over everything, including a step still running. A failure inside a collapsed
 * card is a failure nobody reads, so the card has to advertise it on its own face — and a group
 * whose last step is still going has not stopped being a group that already broke.
 */
function summarise(steps: readonly Step[]): StepStatus {
  if (steps.some((step) => step.status === "failed")) return "failed";
  if (steps.some((step) => step.status === "running")) return "running";
  return "ok";
}

/**
 * What the card says when it is shut.
 *
 * A count rather than a list: the list is one click away, and the number is what tells somebody
 * whether the last minute was one file or the whole project.
 */
export function groupSummary(group: StepGroup): string {
  const count = group.steps.length;
  const actions = count === 1 ? "1 action" : `${count} actions`;

  if (group.failed > 0) return `${actions} · ${group.failed} failed`;
  return actions;
}
