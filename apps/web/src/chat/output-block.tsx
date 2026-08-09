"use client";

/**
 * A block of machine output, clamped to something a transcript can carry.
 *
 * A build log or a file listing is thousands of lines, and pasting it into the chat buries
 * everything either side of it. So the block keeps the **last** `CLAMP_LINES` — output is read
 * for how it ended, and the error is at the bottom — and offers the rest behind a control that
 * names how much is hidden. "Show more" alone leaves the reader guessing whether that is two
 * lines or two thousand.
 */

import { useState } from "react";

export const CLAMP_LINES = 12;

export function OutputBlock({ text, tone = "muted" }: { text: string; tone?: "muted" | "danger" }) {
  const [expanded, setExpanded] = useState(false);

  // A trailing newline is how a command's output normally ends; it is not an empty last line.
  const lines = text.replace(/\n$/, "").split("\n");
  if (text === "") return null;

  const hidden = Math.max(0, lines.length - CLAMP_LINES);
  const shown = expanded ? lines : lines.slice(hidden);

  return (
    <div className="mt-1.5">
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mb-1 rounded text-[11px] text-muted underline decoration-edge underline-offset-2 hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        >
          {expanded ? "Show less" : `Show ${hidden} more lines`}
        </button>
      )}
      <pre
        className={`overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed ${
          tone === "danger" ? "text-danger" : "text-muted"
        }`}
      >
        {/*
          One element per line rather than one text node for the block. It costs a span per
          visible line — at most `CLAMP_LINES` until someone expands — and buys output whose
          individual lines are findable, which is what makes "it kept the last twelve" an
          assertion rather than a substring search over the whole log.
        */}
        {shown.map((line, index) => (
          // Output lines have no identity of their own; the index is what they are.
          // biome-ignore lint/suspicious/noArrayIndexKey: a line's position is its identity
          <span key={index} className="block">
            {line}
          </span>
        ))}
      </pre>
    </div>
  );
}
