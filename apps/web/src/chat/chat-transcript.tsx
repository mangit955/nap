"use client";

/**
 * The transcript: a conversation, with the machinery folded up between the turns.
 *
 * It used to be one hairline rail with every event hanging off it — which is an accurate picture
 * of an event log and the wrong picture of a conversation. What somebody is actually reading is
 * an exchange: they asked for something, the agent said what it would do, it went away and did
 * forty small things, and it came back. So the two voices are drawn as two voices — the user's
 * words in a bubble on the right, the agent's as prose across the pane — and the forty small
 * things collapse into one card between them (see `step-group.ts`).
 *
 * Prose is in the sans face and everything the machine authored is mono. That split is the whole
 * type system here, and it says who wrote each line.
 *
 * The container is a `log` landmark, which is what makes new events announce themselves to a
 * screen reader instead of appearing silently — a transcript that only updates visually is
 * unusable for the person who most needs to know the agent is still working.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { NapMark } from "../brand/nap-mark.tsx";
import { turnFailureCopy } from "../errors/failure-copy.ts";
import { type DisplayItem, groupSteps } from "./step-group.ts";
import { StepGroupCard } from "./step-group-card.tsx";
import { StreamingText } from "./streaming-text.tsx";
import { buildTranscript } from "./transcript.ts";

export function ChatTranscript({
  events,
  onRetry,
}: {
  events: readonly StoredEvent[];
  /** Re-sends a failed turn's message. Absent means no retry is offered, not a broken button. */
  onRetry?: ((message: string) => void) | undefined;
}) {
  const items = groupSteps(buildTranscript(events));
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
      className="flex flex-col gap-3 px-4 py-4"
    >
      {items.map((item, index) => (
        <Item
          key={item.key}
          item={item}
          live={item.key === liveKey}
          // Whether the agent has already spoken since the last thing the user said. Its prose
          // is labelled once per block rather than once per paragraph, the way a chat names a
          // speaker only when the speaker changes.
          opensBlock={opensBlock(items, index)}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}

/**
 * Whether this item starts a new stretch of the agent talking.
 *
 * The label is drawn against the first of them, so a turn that says three things separated by
 * tool calls is not signed three times.
 */
function opensBlock(items: readonly DisplayItem[], index: number): boolean {
  const item = items[index];
  if (item?.kind !== "message" || item.from !== "agent") return false;

  const previous = items[index - 1];
  return previous === undefined || previous.kind !== "message" || previous.from !== "agent";
}

function Item({
  item,
  live,
  opensBlock,
  onRetry,
}: {
  item: DisplayItem;
  /** Whether this item can still be added to. Only ever true of the last one, mid-turn. */
  live: boolean;
  opensBlock: boolean;
  onRetry?: ((message: string) => void) | undefined;
}) {
  switch (item.kind) {
    case "message":
      // The user's words in a bubble on the right, the agent's as prose across the pane. The
      // asymmetry is deliberate and it is the oldest convention in the medium: what you said is
      // a short thing you can find again by its shape, and what the agent said is something to
      // read. Making both bubbles gives a paragraph of explanation the shape of a text message.
      return item.from === "user" ? (
        <div className="flex justify-end pt-1">
          <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-bubble px-3.5 py-2 text-[13px] text-ink leading-relaxed">
            {/*
              Read aloud but not drawn: the two speakers are told apart visually by position and
              shape, which is nothing at all to someone listening to the page.
            */}
            <span className="sr-only">You: </span>
            {item.text}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {opensBlock && (
            <span
              aria-hidden="true"
              className="flex items-center gap-1.5 font-display font-semibold text-[12px] text-muted"
            >
              <NapMark className="size-4" />
              nap
            </span>
          )}
          <p className="whitespace-pre-wrap text-[13.5px] text-ink-2 leading-[1.65]">
            <span className="sr-only">Agent: </span>
            <StreamingText text={item.text} live={live} />
          </p>
        </div>
      );

    case "thinking":
      return (
        <p className="whitespace-pre-wrap text-[12px] text-muted/70 italic leading-relaxed">
          <StreamingText text={item.text} live={live} />
        </p>
      );

    case "steps":
      return <StepGroupCard group={item} />;

    case "preview":
      /*
       * **Announced, not drawn.** This used to be a visible meta row reading "Preview ready ·
       * 5173-i59080byuko8pdezzh7u6.e2b.app", and on screen it is pure noise: the bar above
       * already shows the host, the bar already has a link to open it, and the Preview tab is
       * showing the running app. A restarting dev server emits another one, so a long session
       * silts up with thirty-character subdomains nobody reads.
       *
       * It survives for somebody who cannot see any of that. "The app is running, and here is
       * where" is real information, and the log is the only place it reaches them — so the text
       * and the link stay in the accessibility tree while nothing appears in the transcript.
       */
      return (
        <p className="sr-only">
          Preview ready ·{" "}
          <a
            href={item.url}
            target="_blank"
            // The preview is the user's own app served from another origin; `noopener` keeps
            // it from reaching back into this tab.
            rel="noopener noreferrer"
          >
            {new URL(item.url).host}
          </a>
        </p>
      );

    case "preview-stopped":
      return <Meta>Preview stopped · the project was put away</Meta>;

    case "notice":
      // Labelled in words rather than by colour, so it survives being read aloud and being read
      // by someone who cannot tell the two colours apart.
      return (
        <p
          className={`font-mono text-[11.5px] leading-relaxed ${
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
      // **A rule, not a line of text.** "Started" spelled out was bookkeeping: the bubble above
      // it already says a turn began, and the word was one more thing between the reader and
      // the work. The word survives as `sr-only`, because a hairline is not visible to somebody
      // listening and a turn boundary is real information.
      //
      // No `role="separator"`, deliberately: that role is for a widget dividing two panes, and
      // claiming it here would put a focusable-looking thing between every pair of turns. This
      // is a paragraph break drawn as a line.
      return (
        <div className="my-1 flex items-center first:hidden">
          <span className="sr-only">Turn started</span>
          <span aria-hidden="true" className="h-px flex-1 bg-edge" />
        </div>
      );

    case "turn-end":
      return item.outcome === "completed" ? (
        <Meta>
          Done · {(item.durationMs / 1000).toFixed(1)}s · {item.inputTokens} in /{" "}
          {item.outputTokens} out ·{" "}
          {item.commitSha === null ? "no file changes" : <span>{item.commitSha}</span>}
        </Meta>
      ) : (
        <TurnFailure item={item} onRetry={onRetry} />
      );
  }
}

/**
 * A line about the turn rather than from it.
 *
 * Centred between two hairlines, so it reads as a boundary in the conversation instead of as
 * something one of the two speakers said.
 */
function Meta({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2.5 font-mono text-[11px] text-muted">
      <span aria-hidden="true" className="h-px flex-1 bg-edge" />
      <span className="shrink-0">{children}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-edge" />
    </p>
  );
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
  item: Extract<DisplayItem, { kind: "turn-end" }> & { outcome: "failed" };
  onRetry?: ((message: string) => void) | undefined;
}) {
  const copy = turnFailureCopy(item.reason, item.message);
  const message = item.retryMessage;
  const canRetry =
    copy.recovery === "retry" && onRetry !== undefined && message !== undefined && message !== "";

  return (
    <div className="flex flex-col gap-1 rounded-xl border border-danger/30 bg-danger/[0.06] px-3 py-2.5">
      <p className="font-medium text-[13px] text-danger">{copy.title}</p>
      {/* Mono, because this half is the machine talking — the same split the rest of the pane uses. */}
      <p className="font-mono text-[11px] text-muted">{copy.detail}</p>
      <p className="text-[12px] text-muted">{copy.action}</p>

      {canRetry && (
        <button
          type="button"
          onClick={() => onRetry(message)}
          className="mt-1.5 self-start rounded-chip border border-edge px-2 py-1 text-[11px] text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        >
          Try again
        </button>
      )}
    </div>
  );
}
