"use client";

/**
 * A block of machine output, clamped to something a transcript can carry.
 *
 * A build log or a file listing is thousands of lines, and pasting it into the chat buries
 * everything either side of it. So the block keeps `CLAMP_LINES` of it and offers the rest
 * behind a control that names how much is hidden. "Show more" alone leaves the reader guessing
 * whether that is two lines or two thousand.
 *
 * **Which end it keeps is the caller's, because the two kinds of text are read from opposite
 * ends.** Command output is read for how it ended — the error is at the bottom — so `tail` is
 * the default. A verifier's repair prompt is read from the top: the sentence naming the check
 * that failed is its first line, and clamping that away leaves a fenced stack trace attributed
 * to nothing.
 */

import { useState } from "react";

export const CLAMP_LINES = 12;

export function OutputBlock({
  text,
  tone = "muted",
  keep = "tail",
}: {
  text: string;
  tone?: "muted" | "danger";
  keep?: "head" | "tail";
}) {
  const [expanded, setExpanded] = useState(false);

  // A trailing newline is how a command's output normally ends; it is not an empty last line.
  const lines = text.replace(/\n$/, "").split("\n");
  if (text === "") return null;

  const hidden = Math.max(0, lines.length - CLAMP_LINES);
  const shown = expanded
    ? lines
    : keep === "head"
      ? lines.slice(0, CLAMP_LINES)
      : lines.slice(hidden);

  // The control sits on the side the clamp cut from, so it reads as the continuation of what is
  // on screen rather than as a heading over it.
  const control = hidden > 0 && (
    <button
      type="button"
      onClick={() => setExpanded(!expanded)}
      className={`rounded text-[11px] text-muted underline decoration-edge underline-offset-2 hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
        keep === "head" ? "mt-1" : "mb-1"
      }`}
    >
      {expanded ? "Show less" : `Show ${hidden} more lines`}
    </button>
  );

  return (
    <div className="mt-1.5">
      {keep === "tail" && control}
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
      {keep === "head" && control}
    </div>
  );
}
