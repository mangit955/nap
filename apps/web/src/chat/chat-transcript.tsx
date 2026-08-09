"use client";

/**
 * The transcript: everything that happened, on one rail.
 *
 * A turn is a sequence of small machine actions with occasional prose in the middle, and the
 * thing a reader needs is to see the shape of it at a glance — where it started, what it is
 * doing now, whether it ended. So a single hairline runs down the pane and every item hangs off
 * it: the rail *is* the turn, it opens at `turn.started` and stops at `turn.completed` or
 * `turn.failed`. Prose sits in the sans face at full width; everything the machine authored is
 * mono. That split is the whole type system here, and it says who wrote each line.
 *
 * The container is a `log` landmark, which is what makes new events announce themselves to a
 * screen reader instead of appearing silently — a transcript that only updates visually is
 * unusable for the person who most needs to know the agent is still working.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { OutputBlock } from "./output-block.tsx";
import { ToolStep } from "./tool-step.tsx";
import { buildTranscript, type TranscriptItem } from "./transcript.ts";

const FAILURE_WORDS = {
  refusal: "the model declined",
  budget_exceeded: "budget exceeded",
  cancelled: "cancelled",
  sandbox_unavailable: "sandbox unavailable",
  internal: "internal error",
} as const;

export function ChatTranscript({ events }: { events: readonly StoredEvent[] }) {
  const items = buildTranscript(events);

  return (
    <div
      // A `log`, not a `list`: additions are announced, which is the point of a transcript that
      // grows while you watch it. Its children are deliberately plain elements — `listitem`
      // under a `log` is an orphaned role, and the items are heterogeneous blocks rather than
      // peers in a list.
      role="log"
      aria-label="Transcript"
      className="flex flex-col px-4 py-3"
    >
      {items.map((item) => (
        <Row key={item.key} item={item} />
      ))}
    </div>
  );
}

/** Every item hangs off the rail, so the rail is drawn once, here. */
function Row({ item }: { item: TranscriptItem }) {
  return (
    <div className="relative border-edge border-l pb-2 pl-4 last:pb-0">
      <Item item={item} />
    </div>
  );
}

function Item({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "message":
      return (
        <p
          className={`whitespace-pre-wrap text-sm leading-relaxed ${
            item.from === "user" ? "text-ink" : "text-muted"
          }`}
        >
          {/*
            Read aloud but not drawn: the two speakers are told apart visually by weight and
            colour, which is nothing at all to someone listening to the page.
          */}
          <span className="sr-only">{item.from === "user" ? "You: " : "Agent: "}</span>
          {item.text}
        </p>
      );

    case "thinking":
      return (
        <p className="whitespace-pre-wrap text-muted/70 text-xs italic leading-relaxed">
          {item.text}
        </p>
      );

    case "step":
      return <ToolStep step={item} />;

    case "files":
      // A change with no step to hang it on — the tool call it belonged to arrived before
      // this client connected. Its own disclosure, since there is no step to open.
      return (
        <>
          {item.files.map((file) => (
            <details key={file.path}>
              <summary className="flex cursor-pointer list-none items-baseline gap-1.5 font-mono text-[11px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent">
                <span className="text-ink">{file.path}</span>
                <span className="text-muted">
                  +{file.added} −{file.removed}
                </span>
              </summary>
              <OutputBlock text={file.diff} />
            </details>
          ))}
        </>
      );

    case "preview":
      return (
        <p className="font-mono text-muted text-xs">
          Preview ready ·{" "}
          <a
            href={item.url}
            target="_blank"
            // The preview is the user's own app served from another origin; `noopener` keeps
            // it from reaching back into this tab.
            rel="noopener noreferrer"
            className="text-accent underline underline-offset-2"
          >
            {new URL(item.url).host}
          </a>
        </p>
      );

    case "notice":
      // Mono and labelled, like every other machine-authored line. The label is drawn rather
      // than implied by colour, so it survives being read aloud and being read by someone who
      // cannot tell the two colours apart.
      return (
        <p
          className={`font-mono text-xs leading-relaxed ${
            item.level === "warning" ? "text-danger" : "text-muted"
          }`}
        >
          <span className="uppercase tracking-wide">
            {item.level === "warning" ? "Warning" : "Note"}
          </span>{" "}
          · {item.text}
        </p>
      );

    case "turn-start":
      return <p className="font-mono text-[11px] text-muted uppercase tracking-wide">Started</p>;

    case "turn-end":
      return item.outcome === "completed" ? (
        <p className="font-mono text-[11px] text-muted">
          Done · {(item.durationMs / 1000).toFixed(1)}s · {item.inputTokens} in /{" "}
          {item.outputTokens} out ·{" "}
          {item.commitSha === null ? "no file changes" : <span>{item.commitSha}</span>}
        </p>
      ) : (
        <p className="font-mono text-[11px] text-danger">
          Failed · {FAILURE_WORDS[item.reason]} · {item.message}
        </p>
      );
  }
}
