"use client";

/**
 * A run of tool calls, as one card.
 *
 * The transcript used to draw twenty mono lines for a turn that read twenty files, which is a
 * wall the eye slides off — and the two lines that mattered, the failure and the file that
 * changed, were somewhere in the middle of it. So the run collapses to a single face: what it is
 * doing now while it is going, and how much it did once it has stopped.
 *
 * `<details>` again, so the disclosure semantics, the keyboard handling and the `aria-expanded`
 * nobody has to remember to update all come from the platform.
 *
 * **A group containing a failure opens itself.** That is the rule the individual steps already
 * followed, lifted to the group: everything else is one click away, but a failure the reader has
 * to go looking for is a failure they will miss.
 */

import { AlertIcon, CheckIcon, ChevronRight, SpinnerIcon } from "../ui/icons.tsx";
import { OutputBlock } from "./output-block.tsx";
import { groupSummary, type StepGroup } from "./step-group.ts";
import { ToolStep } from "./tool-step.tsx";
import { stepTarget } from "./working-state.ts";

/** Short verbs, the same ones the rows use. Present tense, because this is what is happening. */
const LIVE_VERBS = {
  read_file: "Reading",
  write_file: "Writing",
  edit_file: "Editing",
  list_files: "Listing",
  search_files: "Searching",
  run_command: "Running",
} as const;

export function StepGroupCard({ group }: { group: StepGroup }) {
  const failed = group.status === "failed";
  const running = group.status === "running";

  return (
    <details
      open={failed}
      className="group/card overflow-hidden rounded-xl border border-edge bg-field/60"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2.5 text-[12.5px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent">
        <Status status={group.status} />

        <span className={`min-w-0 flex-1 truncate ${failed ? "text-danger" : "text-ink-2"}`}>
          {/*
            While it is going, the card says what it is *doing* — a count that climbs from 1 to 8
            tells somebody the agent is busy and nothing else. Once it stops, the count is the
            useful fact, because the thing it was doing is over.
          */}
          {running ? <Live group={group} /> : groupSummary(group)}
        </span>

        <ChevronRight className="size-4 shrink-0 text-muted transition-transform duration-150 group-open/card:rotate-90" />
      </summary>

      <div className="flex flex-col gap-px border-edge border-t px-1.5 py-1.5">
        {group.steps.map((step) => (
          <ToolStep key={step.key} step={step} />
        ))}

        {/*
          Changes with no step to hang them on — a client that connected between a tool call and
          its result. Their own disclosure, since there is no step's body to sit inside.
        */}
        {group.files.map((file) => (
          <details key={file.path} className="px-2 py-1">
            <summary className="flex cursor-pointer list-none items-baseline gap-1.5 font-mono text-[11px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent">
              <span className="text-ink">{file.path}</span>
              <span className="text-muted">
                +{file.added} −{file.removed}
              </span>
            </summary>
            <OutputBlock text={file.diff} />
          </details>
        ))}
      </div>
    </details>
  );
}

/**
 * The step still going, named.
 *
 * Reuses `stepTarget`, which is what the working indicator already calls to turn a tool's input
 * into the one argument worth reading. A second rule here would eventually disagree with it about
 * what a `run_command` is called.
 */
function Live({ group }: { group: StepGroup }) {
  const step = group.steps.findLast((candidate) => candidate.status === "running");
  if (step === undefined) return groupSummary(group);

  return (
    <>
      <span className="nap-shimmer">{LIVE_VERBS[step.toolName]}</span>{" "}
      <span className="font-mono text-[11.5px] text-muted">{stepTarget(step)}</span>
    </>
  );
}

/**
 * The glyph on the card's left.
 *
 * It repeats what the summary says in words rather than replacing it — colour and a shape are
 * faster for somebody who can see them and nothing at all for somebody who cannot, which is why
 * the running and failed states also carry `sr-only` text.
 */
function Status({ status }: { status: StepGroup["status"] }) {
  if (status === "failed") {
    return (
      <>
        <AlertIcon className="size-4 shrink-0 text-danger" />
        <span className="sr-only">Failed: </span>
      </>
    );
  }

  if (status === "running") {
    return (
      <>
        <SpinnerIcon className="size-4 shrink-0 text-accent-ink" />
        <span className="sr-only">Working: </span>
      </>
    );
  }

  return <CheckIcon className="size-4 shrink-0 text-muted" />;
}
