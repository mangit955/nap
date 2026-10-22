"use client";

/**
 * What an opened row of the work log shows.
 *
 * Laid out like T3 Code's tool-call bodies (`V2ItemInspector.tsx`, `ShellCommandBlock.tsx`,
 * `CommandOutputPanel.tsx`; MIT — see `apps/web/THIRD_PARTY_NOTICES.md`): indented under the
 * row's icon, mono at the smallest size, capped at 16rem and scrolling inside itself. A command
 * shows itself highlighted, then what it printed with its terminal colours — following the tail
 * while it is still printing — then `exit N` in `danger` if it did not exit cleanly. A change shows
 * its diff; a read shows what it read; reasoning shows the whole passage.
 */

import { useLayoutEffect, useRef } from "react";
import { ansiSpans } from "./ansi.ts";
import { ChatMarkdown } from "./chat-markdown.tsx";
import { HighlightedCode } from "./highlight.tsx";
import type { FileChange } from "./transcript.ts";
import { commandExitCode, type WorkEntry } from "./work-log.ts";
import { shorten } from "./working-state.ts";

const BODY =
  "max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed select-text";

/**
 * The body's colour, chosen here rather than appended to a muted base: two colour utilities on
 * one element are resolved by their order in the built stylesheet, not by the order they are
 * written in, and there `text-muted` comes after `text-danger` — a failure would render grey.
 */
function bodyClass(danger: boolean): string {
  return `${BODY} ${danger ? "text-danger" : "text-muted"}`;
}

export function WorkEntryBody({ entry }: { entry: WorkEntry }) {
  if (entry.kind === "thinking") return <ChatMarkdown text={entry.text} streaming={false} />;
  if (entry.kind === "files") return <Changes files={entry.files} />;

  const failed = entry.status === "failed";
  const input = entry.input as Record<string, unknown>;

  if (entry.toolName === "run_command") {
    const command = typeof input.command === "string" ? input.command : undefined;
    const code = commandExitCode(entry);
    // What it printed, from the stream when there was one: the result repeats it after an
    // `exit code N` line, and showing both prints the build log twice.
    const printed =
      entry.streamed !== "" ? entry.streamed : entry.output.replace(/^exit code -?\d+\n?/, "");
    // A call that failed without exiting — it timed out, or the sandbox went away — says why only
    // in its result, which the stream above does not contain.
    const reason = failed && code === undefined && entry.streamed !== "" ? entry.output : "";
    return (
      <div className="ms-7 space-y-1.5 font-mono text-2xs">
        {command !== undefined && <ShellCommand command={command} />}
        {printed.trim() !== "" && (
          <CommandOutput text={printed} live={entry.status === "running"} danger={failed} />
        )}
        {reason.trim() !== "" && <pre className={bodyClass(true)}>{reason}</pre>}
        {code !== undefined && code !== 0 && <div className="text-danger">exit {code}</div>}
      </div>
    );
  }

  if (entry.toolName === "read_file") {
    const path = typeof input.path === "string" ? shorten(input.path) : "";
    return (
      <div className="ms-7">
        <pre className={bodyClass(failed)}>{failed ? entry.output : path}</pre>
      </div>
    );
  }

  if (entry.files.length > 0) return <Changes files={entry.files} />;
  return (
    <div className="ms-7">
      <pre className={bodyClass(failed)}>{entry.output || "No output."}</pre>
    </div>
  );
}

function ShellCommand({ command }: { command: string }) {
  return (
    <div className="chat-shell whitespace-pre-wrap break-words text-ink/85 [overflow-wrap:anywhere]">
      <HighlightedCode code={command.trim()} language="shellscript" />
    </div>
  );
}

/**
 * Output as the terminal coloured it. Scrolled to its end after every chunk while the command is
 * still running, unless the reader has scrolled up — then it stays put until they scroll back to
 * the bottom.
 */
function CommandOutput({ text, live, danger }: { text: string; live: boolean; danger: boolean }) {
  const scroller = useRef<HTMLPreElement>(null);
  const follow = useRef(true);

  // No dependencies: this re-renders exactly when its output changes.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (live && follow.current && element !== null) element.scrollTop = element.scrollHeight;
  });

  return (
    <pre
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        follow.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
      }}
      className={bodyClass(danger)}
    >
      {ansiSpans(text).map((span, index) =>
        span.classes.length === 0 ? (
          span.text
        ) : (
          // Rebuilt from scratch on every chunk and never reordered.
          // biome-ignore lint/suspicious/noArrayIndexKey: a run's position is its identity
          <span key={index} className={span.classes.join(" ")}>
            {span.text}
          </span>
        ),
      )}
    </pre>
  );
}

/** Each changed file by name, then its diff, additions a step brighter than the rest. */
function Changes({ files }: { files: readonly FileChange[] }) {
  return (
    <div className="ms-7 space-y-2 font-mono text-2xs">
      {files.map((file, index) => (
        // One call can change one file twice; position tells the two apart.
        // biome-ignore lint/suspicious/noArrayIndexKey: a change's position is its identity
        <div key={`${file.path}:${index}`} className="space-y-1">
          <p className="text-ink-2">
            {shorten(file.path)}{" "}
            <span className="text-muted tabular-nums">
              +{file.added} −{file.removed}
            </span>
          </p>
          {file.diff !== "" && (
            <pre className={bodyClass(false)}>
              {file.diff
                .replace(/\n$/, "")
                .split("\n")
                .map((line, at) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a diff line's position is its identity
                  <span key={at} className={`block ${line.startsWith("+") ? "text-ink-2" : ""}`}>
                    {line}
                  </span>
                ))}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}
