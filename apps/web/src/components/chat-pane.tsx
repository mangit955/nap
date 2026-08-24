"use client";

import type { ModelChoice } from "@nap/shared/models-protocol";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { useMemo, useRef, useState } from "react";
import { ApiKeyPanel } from "../account/api-key-panel.tsx";
import { useApiKey } from "../account/use-api-key.ts";
import { NapMark } from "../brand/nap-mark.tsx";
import { ChatInput } from "../chat/chat-input.tsx";
import { ChatTranscript } from "../chat/chat-transcript.tsx";
import { JobStrip } from "../chat/job-strip.tsx";
import { jobView, type SessionJobView } from "../chat/job-summary.ts";
import { groupSteps } from "../chat/step-group.ts";
import { buildTranscript, type TranscriptItem } from "../chat/transcript.ts";
import { TranscriptSkeleton } from "../chat/transcript-skeleton.tsx";
import { seamAt } from "../chat/unseen.ts";
import { UnseenCard } from "../chat/unseen-card.tsx";
import type { UnseenSummary } from "../chat/unseen-summary.ts";
import { useFirstPrompt } from "../chat/use-first-prompt.ts";
import { useModels } from "../chat/use-models.ts";
import { useSeenCursor } from "../chat/use-seen-cursor.ts";
import { useStickToBottom } from "../chat/use-stick-to-bottom.ts";
import { useTurnSubmission } from "../chat/use-turn-submission.ts";
import { useUnseenCard } from "../chat/use-unseen-card.ts";
import { WorkingIndicator } from "../chat/working-indicator.tsx";
import { turnStartedAt, workingLabel } from "../chat/working-state.ts";
import { EXAMPLE_PROMPTS } from "../dashboard/example-prompts.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import type { SessionLog } from "../hooks/use-session-log.ts";
import { Pane } from "./pane.tsx";

/** A session nothing has been asked of yet, for the callers that have no log to derive one from. */
const NO_JOBS = jobView([]);

/**
 * The transcript pane: what the agent is doing, as it does it — and where you say what to do.
 *
 * Split the way the connection indicator is — the half that renders takes events as a prop and
 * is what every test mounts, and the half that subscribes owns the socket. That is what keeps
 * two dozen render tests free of the network.
 *
 * The optimistic message is rendered *after* the transcript rather than inside it: the
 * transcript is folded from stored events, and this one has not been stored yet. See
 * `use-turn-submission.ts` for why that boundary is worth keeping.
 */
export function ChatPane({
  events,
  jobs = NO_JOBS,
  loading = false,
  pending,
  running = false,
  error,
  onSubmit = () => {},
  onCancel = () => {},
  onRetry,
  files,
  models,
  model,
  onModelChange,
  onAddKey,
  seen,
  card,
  onDismissCard = () => {},
}: {
  events: readonly StoredEvent[];
  /**
   * Where the session's jobs stand, derived above this pane because the workspace bar reads the
   * same answer. Defaulted to the empty session — a constant rather than a second derivation, so
   * the many render tests that are not about jobs need not supply one and none of them can end
   * up describing a different log from the one they passed.
   */
  jobs?: SessionJobView;
  /**
   * The log has not arrived yet, which is *not* the same as there being none.
   *
   * Without it this pane greets a project with forty turns in it by inviting the user to
   * describe an app — the empty state is the honest answer to "no events" and the wrong answer
   * to "no events yet", and nothing in a list of events distinguishes the two.
   */
  loading?: boolean;
  pending?: string | undefined;
  running?: boolean;
  error?: string | undefined;
  onSubmit?: (message: string) => void;
  onCancel?: () => void;
  /** Re-sends a failed turn's message. Optional so the many render tests need not supply one. */
  onRetry?: ((message: string) => void) | undefined;
  /** The project's files, for the composer's `@` menu. */
  files?: readonly string[] | undefined;
  /** What this deployment will run a turn on, and which of them is chosen. */
  models?: readonly ModelChoice[] | undefined;
  model?: string | undefined;
  onModelChange?: ((model: string) => void) | undefined;
  /** Opening the key form, for a model this caller cannot reach. */
  onAddKey?: (() => void) | undefined;
  /**
   * Where this browser's reading stopped, from `useSeenCursor`. Absent for every pane that is
   * not subscribed to a session — the tests, and the landing page's scripted demo.
   */
  seen?: number | undefined;
  /**
   * What was decided while nobody was watching, from `useUnseenCard`, or `null` when nothing
   * was — which is most of the time, by design. Worked out above rather than here because it is
   * a fact about a moment that has passed, and this pane re-renders on every event.
   */
  card?: UnseenSummary | null | undefined;
  /**
   * Optional for the same reason `card` is — the many render tests supply neither — and paired
   * with it: a caller passing one without the other draws a card whose only control does nothing.
   */
  onDismissCard?: (() => void) | undefined;
}) {
  const empty = events.length === 0 && pending === undefined;
  // Folded once, read twice: the transcript renders it and the working indicator reads the last
  // step out of it. Both used to fold the log for themselves, so every frame of a streaming turn
  // walked it twice to answer one question.
  const transcript = useMemo(() => buildTranscript(events), [events]);
  const items = useMemo(() => groupSteps(transcript), [transcript]);
  // Where the reader left off, as a position in what is drawn rather than in the log. See
  // `unseen.ts` for why an item straddling the cursor stays above the line.
  const seam = useMemo(() => seamAt(items, seen), [items, seen]);
  const seamRef = useRef<HTMLElement>(null);
  // What "there is something new to see" means here. The event count alone would miss a turn
  // ending, and the running flag alone would miss every event inside it. The seam is in it
  // because it arrives from an effect a frame after mount, in a commit where nothing else
  // changed — and a scroller that did not look then would open at the bottom and stay there.
  const scroller = useStickToBottom<HTMLDivElement>(
    `${events.length}:${pending}:${running}:${seam}`,
    () => seamRef.current,
  );

  return (
    <Pane id="chat" title="Chat" chrome="none">
      <div className="flex h-full min-h-0 flex-col">
        {/*
          Above the scroller rather than inside it: the strip is the job's current state, and a
          state that scrolls away with the conversation is one somebody has to go looking for
          during the exact minute it matters.
        */}
        <JobStrip jobs={jobs} />

        {/*
          Over the seam, and above the scroller for the reason the strip is: a summary of what
          happened in your absence that scrolls away with the conversation is one somebody has
          to go looking for. The seam stays where it is either way — this is additive to it,
          and dismissing this leaves the transcript exactly as it was.
        */}
        {card != null && (
          <UnseenCard
            card={card}
            onDismiss={() => {
              // Dismissing means "read", so it drops the reader at the live state rather than
              // leaving them parked at a marker they have just finished with. Set before the
              // card unmounts; the browser clamps to whatever the new bottom turns out to be.
              const box = scroller.current;
              if (box !== null) box.scrollTop = box.scrollHeight;
              onDismissCard();
            }}
          />
        )}

        <div
          ref={scroller} // `overflow-x-hidden`, not `auto`: tool output is arbitrary text, and a long line
          // belongs scrolling inside its own `OutputBlock` rather than dragging the whole
          // conversation sideways.
          className="nap-scroll relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        >
          {empty && loading ? (
            <TranscriptSkeleton />
          ) : empty ? (
            <EmptyState onPick={onSubmit} />
          ) : (
            <>
              {events.length > 0 && (
                <ChatTranscript items={items} seam={seam} seamRef={seamRef} onRetry={onRetry} />
              )}
              {pending !== undefined && <PendingMessage text={pending} />}
            </>
          )}

          {running && <Working events={events} transcript={transcript} />}
        </div>

        <ChatInput
          running={running}
          error={error}
          onSubmit={onSubmit}
          onCancel={onCancel}
          {...(files === undefined ? {} : { files })}
          {...(models === undefined ? {} : { models })}
          {...(model === undefined ? {} : { model })}
          {...(onModelChange === undefined ? {} : { onModelChange })}
          {...(onAddKey === undefined ? {} : { onAddKey })}
        />
      </div>
    </Pane>
  );
}

/**
 * The message the user just sent, before the log has caught up with it.
 *
 * Drawn exactly like a stored user message — same bubble, same face, same side — because it *is*
 * the same message. A differently-styled placeholder that swaps for the real thing a moment later
 * is a flicker with no meaning behind it.
 */
function PendingMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end px-4 pb-3">
      <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-bubble px-3.5 py-2 text-[13px] text-ink leading-relaxed">
        <span className="sr-only">You: </span>
        {text}
      </p>
    </div>
  );
}

/**
 * The last thing in the pane while a turn is open.
 *
 * Outside the `log`, for the reason `PendingMessage` is: the transcript is folded from stored
 * events and this is not one of them — it is the *absence* of the next event, which is precisely
 * what nothing in the log can express.
 */
function Working({
  events,
  transcript,
}: {
  events: readonly StoredEvent[];
  transcript: readonly TranscriptItem[];
}) {
  const startedAt = turnStartedAt(events);

  return (
    <div className="px-4 pb-3">
      <WorkingIndicator
        label={workingLabel(transcript)}
        {...(startedAt === undefined ? {} : { startedAt })}
      />
    </div>
  );
}

/**
 * An empty screen is an invitation, so it says what to do rather than what this is.
 *
 * The examples are the same four the front page offers, from one list rather than a second copy
 * — they are chosen to be small and finishable, and a divergent set here would be a different
 * promise about what this thing is for. They send a turn directly rather than filling the box:
 * a prompt somebody has to press twice is a prompt with a step in it for no reason.
 */
function EmptyState({ onPick }: { onPick: (message: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-6 py-10 text-center">
      <NapMark className="size-9 text-muted" />

      <div className="flex flex-col gap-1.5">
        <p className="font-display font-semibold text-[15px] text-ink">Describe the app you want</p>
        <p className="max-w-[34ch] text-[12.5px] text-muted leading-relaxed">
          Every file the agent writes and every command it runs shows up here as it happens.
        </p>
      </div>

      <ul aria-label="Example prompts" className="flex flex-col items-stretch gap-1.5">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <li key={prompt}>
            <button
              type="button"
              onClick={() => onPick(prompt)}
              className="w-full rounded-chip border border-edge bg-field/60 px-3 py-2 text-left text-[12.5px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            >
              {prompt}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LiveChatPane({
  sessionId,
  projectId,
  log,
  files,
  fetchJson,
}: {
  sessionId: string | undefined;
  /** Only so a prompt typed on the front page can be claimed by the project it was meant for. */
  projectId?: string | undefined;
  /** The workspace's one subscription, resolved above. See `useSessionLog`. */
  log: SessionLog;
  /** The project's files, for the composer's `@` menu; listed once for the whole workspace. */
  files?: readonly string[] | undefined;
  fetchJson?: FetchJson | undefined;
}) {
  const { events, replayed, lastSeq, jobs } = log;
  // Subscribed here rather than in `useSessionLog` with the other folds: this is the one answer
  // in the workspace that is not a fold over the log at all — it is a fact about this browser,
  // and only this pane draws it.
  const seen = useSeenCursor(sessionId, lastSeq);
  // Beside the cursor, and for the same reason: it is a fact about this browser rather than a
  // fold over the log, and only this pane draws it. Worked out here rather than in the pane
  // below because it needs `replayed` — a card decided before the log arrived would be a card
  // decided over an empty one.
  const { card, dismiss } = useUnseenCard(events, seen, replayed);
  const injected = fetchJson === undefined ? {} : { fetchJson };
  const { submit, cancel, pending, running, error } = useTurnSubmission({
    sessionId,
    events,
    ...injected,
  });
  const { models } = useModels(injected);
  // Somebody who meets a locked model, or a turn refused for want of a key, should be able to
  // fix it here rather than being sent to the dashboard and back.
  const key = useApiKey(injected);
  const [keyPanelOpen, setKeyPanelOpen] = useState(false);
  // Held here rather than in the composer: the choice has to outlive the box being cleared on
  // send, and a retry has to go out on the same model the user picked.
  const [model, setModel] = useState<string | undefined>(undefined);

  // Through the same submission path as the input, so the front page's first message is an
  // ordinary turn — same optimistic message, same rate limit, same refusal wording.
  useFirstPrompt({
    projectId,
    sessionId,
    submit: (message, firstModel) => {
      // The dashboard's selected model is part of its first prompt. Put it in the workspace
      // state before sending, so the composer stays truthful for the turns that follow.
      if (firstModel !== undefined) setModel(firstModel);
      void submit(message, firstModel);
    },
  });

  return (
    <>
      <ApiKeyPanel open={keyPanelOpen} onClose={() => setKeyPanelOpen(false)} keyState={key} />

      <ChatPane
        events={events}
        jobs={jobs}
        // Nothing has been asked for yet when there is no session: the project record is still on
        // its way, so the log this pane will show has not even been subscribed to.
        loading={sessionId === undefined || (!replayed && events.length === 0)}
        pending={pending}
        running={running}
        error={error}
        onSubmit={(message) => void submit(message, model)}
        onCancel={() => void cancel()}
        // The same submission path as the input: a retry is an ordinary turn, and routing it
        // anywhere else would give it different rate-limit and optimistic-message behaviour.
        onRetry={(message) => void submit(message, model)}
        files={files ?? []}
        models={models?.models ?? []}
        model={model ?? models?.fallback}
        onModelChange={setModel}
        onAddKey={() => setKeyPanelOpen(true)}
        seen={seen}
        card={card}
        onDismissCard={dismiss}
      />
    </>
  );
}
