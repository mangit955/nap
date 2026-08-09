"use client";

/**
 * One thing the agent did, on the rail.
 *
 * A turn is mostly tool calls, and almost none of them are worth reading — the ones that matter
 * are the failure and the file that changed. So a step is a single mono line by default: a verb,
 * the one argument that identifies it, and what it produced. `<details>` does the collapsing,
 * which means keyboard support and the disclosure semantics come from the platform rather than
 * from a click handler and an `aria-expanded` someone has to remember to update.
 *
 * A failed step opens itself. Everything else is one click away, but a failure the reader has
 * to go looking for is a failure they will miss.
 *
 * Status is in the summary as *words*. Colour says the same thing faster for people who can see
 * it, and nothing at all for people who cannot.
 */

import type { ToolName } from "@nap/shared/events";
import { OutputBlock } from "./output-block.tsx";
import type { FileChange, TranscriptItem } from "./transcript.ts";

type Step = Extract<TranscriptItem, { kind: "step" }>;

/** Short verbs, because the column they sit in is read vertically. */
const VERBS: Record<ToolName, string> = {
  read_file: "read",
  write_file: "write",
  edit_file: "edit",
  list_files: "list",
  search_files: "find",
  run_command: "run",
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

/**
 * The one argument that says which call this is. A step's identity is its target, not its
 * full arguments — those are available by expanding it.
 */
function target(step: Step): string {
  const { command, path, pattern } = step.input as {
    command?: unknown;
    path?: unknown;
    pattern?: unknown;
  };

  for (const value of [command, pattern, path]) {
    if (typeof value === "string" && value !== "") return shorten(value);
  }
  return "";
}

/** Paths are absolute in the sandbox; the project root is noise in every single line. */
function shorten(value: string): string {
  return value.replace("/home/user/app/", "");
}

export function ToolStep({ step }: { step: Step }) {
  const failed = step.status === "failed";
  const running = step.status === "running";

  // `run_command` reports its own stdout back to the model, so showing both would print the
  // build log twice.
  const streamed = step.streamed;
  const result = streamed !== "" && step.output.includes(streamed.trimEnd()) ? "" : step.output;

  return (
    <details open={failed} className="group">
      <summary className="flex cursor-pointer list-none items-baseline gap-2 rounded py-0.5 font-mono text-xs focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent">
        <span aria-hidden="true" className="text-edge transition-transform group-open:rotate-90">
          ▸
        </span>
        <span className={failed ? "text-danger" : "text-ink"}>{VERBS[step.toolName]}</span>
        <span className="min-w-0 flex-1 truncate text-muted">{target(step)}</span>
        <span className={`shrink-0 text-[11px] ${failed ? "text-danger" : "text-muted"}`}>
          {STATUS_WORDS[step.status]}
        </span>
        {running && <span className="sr-only">still running</span>}
      </summary>

      <div className="pt-1 pl-5">
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
