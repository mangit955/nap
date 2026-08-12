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
import { turnFailureCopy } from "../errors/failure-copy.ts";
import { OutputBlock } from "./output-block.tsx";
import { StreamingText } from "./streaming-text.tsx";
import { ToolStep } from "./tool-step.tsx";
import { buildTranscript, type TranscriptItem } from "./transcript.ts";

export function ChatTranscript({
  events,
  onRetry,
}: {
  events: readonly StoredEvent[];
  /** Re-sends a failed turn's message. Absent means no retry is offered, not a broken button. */
  onRetry?: ((message: string) => void) | undefined;
}) {
  const items = buildTranscript(events);
  // The only item that can still be added to is the last one — everything above it has been
  // overtaken by something newer. That alone is the whole rule, and it needs no check for
  // whether a turn is open: a turn that ended ends *with* its `turn.completed` or
  // `turn.failed`, so replaying a finished session leaves the last word on a line that has
  // no prose to reveal. Asking `turnStartedAt` as well would look like a safety net and be a
  // bug — a client that reconnected mid-turn has no `turn.started` in its log, and the
  // passage the model is writing right now is exactly what it would refuse to animate.
  const liveKey = items.at(-1)?.key;

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
        <Row key={item.key} item={item} live={item.key === liveKey} onRetry={onRetry} />
      ))}
    </div>
  );
}

/** Every item hangs off the rail, so the rail is drawn once, here. */
function Row({
  item,
  live,
  onRetry,
}: {
  item: TranscriptItem;
  /** Whether this item can still be added to. Only ever true of the last one, mid-turn. */
  live: boolean;
  onRetry?: ((message: string) => void) | undefined;
}) {
  return (
    <div className="relative border-edge border-l pb-2 pl-4 last:pb-0">
      <Item item={item} live={live} onRetry={onRetry} />
    </div>
  );
}

function Item({
  item,
  live,
  onRetry,
}: {
  item: TranscriptItem;
  live: boolean;
  onRetry?: ((message: string) => void) | undefined;
}) {
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
          {item.from === "agent" ? <StreamingText text={item.text} live={live} /> : item.text}
        </p>
      );

    case "thinking":
      return (
        <p className="whitespace-pre-wrap text-muted/70 text-xs italic leading-relaxed">
          <StreamingText text={item.text} live={live} />
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

    case "preview-stopped":
      return (
        <p className="font-mono text-muted text-xs">Preview stopped · the project was put away</p>
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
        <TurnFailure item={item} onRetry={onRetry} />
      );
  }
}

/**
 * A failed turn, said in a way somebody can act on.
 *
 * Three parts, and each earns its place: what failed, the specific reason the server gave, and
 * what to do about it. The old version of this was one mono line reading `Failed · sandbox
 * unavailable · <message>`, which names the failure in the system's vocabulary and stops there.
 *
 * The button appears only when retrying is the right advice *and* there is something to send.
 * A turn that ran out of budget would fail identically on a retry, and a log joined mid-turn has
 * no message to resend — in both cases the action is prose, because a control that cannot help
 * is worse than none.
 */
function TurnFailure({
  item,
  onRetry,
}: {
  item: Extract<TranscriptItem, { kind: "turn-end" }> & { outcome: "failed" };
  onRetry?: ((message: string) => void) | undefined;
}) {
  const copy = turnFailureCopy(item.reason, item.message);
  const message = item.retryMessage;
  const canRetry =
    copy.recovery === "retry" && onRetry !== undefined && message !== undefined && message !== "";

  return (
    <div className="flex flex-col gap-1">
      <p className="text-danger text-sm">{copy.title}</p>
      {/* Mono, because this half is the machine talking — the same split the rest of the rail uses. */}
      <p className="font-mono text-[11px] text-muted">{copy.detail}</p>
      <p className="text-muted text-xs">{copy.action}</p>

      {canRetry && (
        <button
          type="button"
          onClick={() => onRetry(message)}
          className="mt-1 self-start rounded border border-edge px-2 py-0.5 text-[11px] text-muted hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        >
          Try again
        </button>
      )}
    </div>
  );
}
