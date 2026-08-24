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

import { Fragment } from "react";
import { NapMark } from "../brand/nap-mark.tsx";
import { turnFailureCopy } from "../errors/failure-copy.ts";
import { AlertIcon, CopyIcon } from "../ui/icons.tsx";
import { OutputBlock } from "./output-block.tsx";
import type { DisplayItem } from "./step-group.ts";
import { StepGroupCard } from "./step-group-card.tsx";
import { StreamingText } from "./streaming-text.tsx";

export function ChatTranscript({
  items,
  seam,
  seamRef,
  onRetry,
}: {
  /**
   * The log, already folded and grouped.
   *
   * Passed in rather than folded here because the pane above reads the same fold for its working
   * indicator, and two components folding one log is two walks of it per frame of a streaming
   * turn. `groupSteps(buildTranscript(events))` is the whole derivation; see `transcript.ts`.
   */
  items: readonly DisplayItem[];
  /**
   * The key of the first item this browser has never displayed, and where the seam is drawn.
   *
   * The *key*, not the cursor: the caller has the folded items already and `seamAt` in
   * `unseen.ts` is where the rule for turning one into the other lives — including the part
   * about an item that straddles the cursor. Undefined is the ordinary case, and a key nothing
   * matches draws nothing, which is what a windowed log eventually hands over.
   */
  seam?: number | undefined;
  /** Put on the marker, so the scroller can open at it. See `use-stick-to-bottom.ts`. */
  seamRef?: React.RefObject<HTMLElement | null> | undefined;
  /** Re-sends a failed turn's message. Absent means no retry is offered, not a broken button. */
  onRetry?: ((message: string) => void) | undefined;
}) {
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
        <Fragment key={item.key}>
          {item.key === seam && <UnseenSeam seamRef={seamRef} />}
          <Item
            item={item}
            live={item.key === liveKey}
            // Whether the agent has already spoken since the last thing the user said. Its prose
            // is labelled once per block rather than once per paragraph, the way a chat names a
            // speaker only when the speaker changes.
            opensBlock={opensBlock(items, index)}
            onRetry={onRetry}
          />
        </Fragment>
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
      // A prompt the verifier wrote is neither of the two voices below, and drawing it as
      // either is the specific thing this treatment exists to prevent: in a user bubble it
      // reads as the app talking to itself, and as agent prose it reads as the model narrating
      // its own failure. It is the system quoting a check back at the model, so it is labelled
      // as such and set in the machine's face. See `docs/adr/0006`.
      if (item.from === "verifier") return <RepairPrompt text={item.text} />;

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
          <CopyButton text={item.text} />
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
      // The one that still describes the project gets a line; the ones a later restart already
      // answered stay in the log for anybody listening to it, and stay out of the way for
      // everybody reading it. Five identical "put away" lines in a transcript read as five
      // failures rather than as an afternoon of ordinary opening and closing.
      return item.superseded ? (
        <p className="sr-only">Preview stopped · the project was put away</p>
      ) : (
        <Meta>Preview stopped · the project was put away</Meta>
      );

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
      //
      // A repair turn differs here only in what it is called. The visible distinction is the
      // block above it — one label per boundary is enough, and a second would be the same fact
      // twice — but "turn started" would tell somebody listening that the user said something,
      // which for a repair is the one thing that is not true.
      return (
        <div className="my-1 flex items-center first:hidden">
          <span className="sr-only">
            {item.source === "verification" ? "Repair turn started" : "Turn started"}
          </span>
          <span aria-hidden="true" className="h-px flex-1 bg-edge" />
        </div>
      );

    case "turn-end":
      return item.outcome === "completed" ? (
        <Meta>
          {/*
            Just how long it took, and whether anything changed. The token counts and the commit
            SHA used to be here and are instrumentation rather than something a person reads
            between turns — forty characters of hex that also pushed this row wider than the
            pane and gave the whole transcript a horizontal scrollbar. Both are still in the
            event log for anything that wants them.
          */}
          Done · {(item.durationMs / 1000).toFixed(1)}s
          {item.commitSha === null ? " · no file changes" : ""}
        </Meta>
      ) : (
        <TurnFailure item={item} onRetry={onRetry} />
      );
  }
}

/**
 * Where this browser's reading stopped.
 *
 * The honest primitive, and it works for every case including "you were gone eight seconds":
 * a line through the transcript with everything below it unseen. Whatever sits *above* it as a
 * summary is additive and can be cut without leaving a hole here.
 *
 * Drawn like the turn boundary — a rule with a word on it — but in the accent rather than in the
 * edge colour, because this one is about the reader rather than about the log. And it is a word
 * as well as a line: a hairline in a different colour is nothing at all to somebody listening,
 * and "you have not read from here down" is exactly what they need told.
 *
 * The copy is not the domain term. What is computed is `Unseen` — a property of the log against
 * a cursor — and what is said is a sentence about a person, the same split `working-state.ts`
 * and `failure-copy.ts` already make.
 */
function UnseenSeam({ seamRef }: { seamRef?: React.RefObject<HTMLElement | null> | undefined }) {
  return (
    <p
      // Filled through a callback rather than handed the object directly. The caller asks for
      // an `HTMLElement` because it only ever reads an offset off it, and a `RefObject` of the
      // wider type is not a `RefObject` of this one — assigning into it is, and it needs no
      // cast promising that this element is always a paragraph.
      ref={(node) => {
        if (seamRef !== undefined) seamRef.current = node;
      }}
      className="flex items-center gap-2.5 pt-1 font-mono text-[11px] text-accent-ink"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-accent/40" />
      <span className="min-w-0 truncate">New since you were last here</span>
      <span aria-hidden="true" className="h-px flex-1 bg-accent/40" />
    </p>
  );
}

/**
 * Taking one passage of the agent's prose away with you.
 *
 * Scoped to the passage rather than to the turn on purpose. A turn is prose, tool calls, streamed
 * output and a commit line, and "copy" on all of that hands somebody four kilobytes of `vite`
 * banner when they wanted the sentence explaining what changed. The fold has already decided where
 * a passage ends — `transcript.ts` joins a run of `agent.message` events and refuses to join across
 * a tool step — so the boundary this copies is one the reader can see.
 */
function CopyButton({ text }: { text: string }) {
  return (
    <button
      type="button"
      // Named rather than labelled by its glyph: the icon is the only thing drawn, so without
      // this the control reads as "button" to anyone listening.
      aria-label="Copy response"
      onClick={() => {
        // Nothing to do with the promise. It rejects when the document is not focused or the
        // permission is refused, and neither is something to tell the reader about mid-transcript.
        void navigator.clipboard?.writeText(text);
      }}
      className="self-start rounded-chip p-1 text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
    >
      <CopyIcon className="size-3.5" />
    </button>
  );
}

/**
 * What a failed check asked the model to do.
 *
 * The heading is the whole point of the treatment: a reader has to be able to see, without
 * reading a word of the prompt, that the next turn was prompted by the project's own checks
 * rather than by them. Self-correction that looks like the app addressing itself in the user's
 * voice reads as a bug, and it is the demo's best moment.
 *
 * Clamped from the top rather than the bottom. The prompt opens by naming the check that
 * failed and closes with a fenced copy of what it printed, which the verifier budgets at four
 * kilobytes a stream — keeping the tail of that would fill the pane with a stack trace and cut
 * off the sentence saying which check produced it.
 */
function RepairPrompt({ text }: { text: string }) {
  return (
    <div className="flex flex-col rounded-xl border border-edge bg-field/50 px-3 py-2.5">
      <p className="flex items-center gap-1.5 font-medium text-[11.5px] text-muted uppercase tracking-wide">
        <AlertIcon className="size-3.5 shrink-0" />
        Verification asked for a repair
      </p>
      <OutputBlock text={text} keep="head" />
    </div>
  );
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
      {/*
        `min-w-0 truncate` rather than `shrink-0`. A row that cannot shrink pushes the pane
        wider than the window and gives the whole transcript a horizontal scrollbar — which is
        what happened here. Shortening the text that caused it is not the fix; letting the row
        shrink is, so the next long meta line cannot bring the scrollbar back.
      */}
      <span className="min-w-0 truncate">{children}</span>
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
