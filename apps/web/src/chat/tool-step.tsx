"use client";

/**
 * One thing the agent did, as a row inside the group's card.
 *
 * A step is a single line by default: an icon for the kind of work, a verb, the one argument that
 * identifies it, and how it ended. `<details>` does the collapsing, which means the keyboard
 * support and the disclosure semantics come from the platform rather than from a click handler
 * and an `aria-expanded` someone has to remember to update.
 *
 * A failed step opens itself. Everything else is one click away, but a failure the reader has to
 * go looking for is a failure they will miss.
 *
 * **Status is in the summary as words.** Colour and the icon say the same thing faster for people
 * who can see them, and nothing at all for people who cannot.
 */

import type { ToolName } from "@nap/shared/events";
import {
  EyeIcon,
  type IconProps,
  ListIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
} from "../ui/icons.tsx";
import { OutputBlock } from "./output-block.tsx";
import type { FileChange, TranscriptItem } from "./transcript.ts";
import { stepTarget } from "./working-state.ts";

type Step = Extract<TranscriptItem, { kind: "step" }>;

/** Short verbs, because the column they sit in is read vertically. */
const VERBS: Record<ToolName, string> = {
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  list_files: "List",
  search_files: "Find",
  run_command: "Run",
};

/**
 * A shape per tool. A `Record` over the union rather than a lookup with a fallback, so a seventh
 * tool fails typecheck here instead of rendering a row with a hole where its icon should be.
 */
const ICONS: Record<ToolName, (props: IconProps) => React.ReactElement> = {
  read_file: EyeIcon,
  write_file: PencilIcon,
  edit_file: PencilIcon,
  list_files: ListIcon,
  search_files: SearchIcon,
  run_command: TerminalIcon,
};

const STATUS_WORDS = {
  running: "running",
  ok: "done",
  failed: "failed",
} as const;

const CHANGE_WORDS: Record<FileChange["changeType"], string> = {
  created: "created",
  modified: "changed",
  deleted: "deleted",
};

export function ToolStep({ step }: { step: Step }) {
  const failed = step.status === "failed";
  const running = step.status === "running";
  const Icon = ICONS[step.toolName];

  // `run_command` reports its own stdout back to the model, so showing both would print the
  // build log twice.
  const streamed = step.streamed;
  const result = streamed !== "" && step.output.includes(streamed.trimEnd()) ? "" : step.output;

  return (
    <details open={failed} className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-[5px] text-[12px] transition-colors hover:bg-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent">
        <Icon className={`size-3.5 shrink-0 ${failed ? "text-danger" : "text-muted"}`} />

        <span className={`shrink-0 ${failed ? "text-danger" : "text-ink-2"}`}>
          {VERBS[step.toolName]}
        </span>

        {/*
          The argument in mono on its own well: it is a path or a command, and a filename set in
          the same face as the sentence around it is a filename people misread.

          The well hugs its text rather than filling the row — stretched, a short path like
          `src/types.ts` drags a two-inch grey bar across to the status word, which reads as an
          empty input rather than as a label. The flexing happens on the wrapper, so the chip
          still truncates when a `bun run build --with --many --flags` outgrows the row.
        */}
        <span className="min-w-0 flex-1">
          <span className="inline-block max-w-full truncate rounded-[5px] bg-hover px-1.5 py-px align-middle font-mono text-[11px] text-muted">
            {stepTarget(step)}
          </span>
        </span>

        <span className={`shrink-0 text-[11px] ${failed ? "text-danger" : "text-muted"}`}>
          {STATUS_WORDS[step.status]}
        </span>
        {running && <span className="sr-only">still running</span>}
      </summary>

      <div className="pt-1 pb-1.5 pl-7">
        {step.files.length > 0 && (
          <ul className="mb-1 flex flex-wrap gap-1.5">
            {step.files.map((file) => (
              <li
                key={file.path}
                className="flex items-baseline gap-1.5 rounded border border-edge px-1.5 py-0.5 font-mono text-[11px]"
              >
                <span className="text-ink">{file.path}</span>
                <span className="text-muted">{CHANGE_WORDS[file.changeType]}</span>
                <span className="text-muted">
                  +{file.added} −{file.removed}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/*
          The diff sits inside the step's own disclosure rather than behind a second one:
          nesting `<details>` gives the reader two clicks to reach one thing, and by the time
          they have opened a write step, the diff is what they came for.
        */}
        {step.files.map((file) => (
          <OutputBlock key={`${file.path}-diff`} text={file.diff} />
        ))}

        <OutputBlock text={streamed} tone={step.hasStderr ? "danger" : "muted"} />
        <OutputBlock text={result} tone={failed ? "danger" : "muted"} />
      </div>
    </details>
  );
}
