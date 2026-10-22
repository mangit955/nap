"use client";

import type { MediaAttachment } from "@nap/shared/media";

import type { ModelChoice } from "@nap/shared/models-protocol";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiKeyPanel } from "../account/api-key-panel.tsx";
import { useApiKey } from "../account/use-api-key.ts";
import { NapMark } from "../brand/nap-mark.tsx";
import { ChatInput } from "../chat/chat-input.tsx";
import { ChatTranscript } from "../chat/chat-transcript.tsx";
import { ContextControl } from "../chat/context-control.tsx";
import type { FirstPrompt } from "../chat/first-prompt.ts";
import { JobStrip } from "../chat/job-strip.tsx";
import { jobView, type SessionJobView } from "../chat/job-summary.ts";
import { buildTranscript } from "../chat/transcript.ts";
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
import { WorkingRow } from "../chat/work-log-rows.tsx";
import { inFlightTurn } from "../chat/working-state.ts";
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
 * The optimistic message stays outside the transcript fold: it has not been stored yet.
 * Requests queued after compaction attach to the composer; ordinary requests appear below
 * the transcript. See `use-turn-submission.ts` for the request reconciliation.
 */
export function ChatPane({
  draftIdentity,
  active = true,
  events,
  jobs = NO_JOBS,
  loading = false,
  pending,
  pendingAttachments,
  pendingAfterCompaction = false,
  running = false,
  activity,
  error,
  firstPrompt,
  onOpenFile,
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
  draftIdentity?: { ownerId: string; projectId: string } | undefined;
  active?: boolean;
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
  pendingAttachments?: MediaAttachment[] | undefined;
  pendingAfterCompaction?: boolean;
  running?: boolean;
  activity?: { startedAt: string | undefined; openedAt?: string | undefined };
  error?: string | undefined;
  /** The dashboard request, retained until admission so a refusal can restore the composer. */
  firstPrompt?: FirstPrompt | undefined;
  /** Opens a file in the Code tab, from a path in a reply or a changed-files card. */
  onOpenFile?: ((path: string) => void) | undefined;
  onSubmit?: (message: string, attachments?: MediaAttachment[]) => void;
  onCancel?: () => void;
  /** Re-sends a failed turn's message. Optional so the many render tests need not supply one. */
  onRetry?: ((message: string, attachments?: MediaAttachment[]) => void) | undefined;
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
  // Folded once, read twice: the transcript renders it and the composer asks it whether a
  // compaction is running. Both used to fold the log for themselves, so every frame of a
  // streaming turn walked it twice to answer one question.
  const transcript = useMemo(() => buildTranscript(events), [events]);
  // Where the reader left off, as a position in what is drawn rather than in the log. See
  // `unseen.ts` for why an item straddling the cursor stays above the line.
  const seam = useMemo(() => seamAt(transcript, seen), [transcript, seen]);
  const turn = activity === undefined ? inFlightTurn(events) : activity;
  // "Working for" hangs off the prompt it answers. While that prompt is still the optimistic one
  // it is below the transcript, so the row goes under it here rather than inside the log.
  const workingOutside =
    running && ((pending !== undefined && !pendingAfterCompaction) || events.length === 0);
  const workingSince = useWorkingSince(
    running && (pending !== undefined || turn?.openedAt !== undefined),
    turn?.openedAt,
    pending !== undefined && pendingAfterCompaction,
  );
  // The earliest of what this tab saw and what the server wrote, so the count never goes back:
  // the row remounts when the optimistic prompt is replaced by the logged one, `turn.started`
  // lands a sandbox acquisition after the prompt, and a reload has only the server's times. It
  // therefore includes the acquisition, which the fold's "Worked for" — the agent's own
  // `durationMs` — does not; the live count answers "how long have I been waiting".
  const startedAt = earliest(workingSince, turn?.openedAt, turn?.startedAt);
  // The stage is where a dropped file lands, and the composer draws its overlay across it — so it
  // is handed over as an element, which a ref read during render would not be.
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const seamRef = useRef<HTMLElement>(null);
  const composerDock = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(144);
  // Let history scroll behind the glass, with enough space to read the last message above it.
  useLayoutEffect(() => {
    const dock = composerDock.current;
    if (dock === null) return;
    const measure = () => {
      const height = dock.getBoundingClientRect().height;
      if (height > 0) {
        // Keep the expanded inset while resting so returning to the end cannot cover its last row.
        const resting = dock.querySelector('[data-resting="true"]') !== null;
        setComposerHeight((current) => (resting ? Math.max(current, height) : height));
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    return () => observer.disconnect();
  }, []);
  // What "there is something new to see" means here. The event count alone would miss a turn
  // ending, and the running flag alone would miss every event inside it. The seam is in it
  // because it arrives from an effect a frame after mount, in a commit where nothing else
  // changed — and a scroller that did not look then would open at the bottom and stay there.
  const scroller = useStickToBottom<HTMLElement>(
    `${events.length}:${pending}:${running}:${seam}:${composerHeight}`,
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

        <div ref={setStage} className="chat-stage relative min-h-0 flex-1">
          <section
            ref={scroller} // `overflow-x-hidden`, not `auto`: tool output is arbitrary text, and a long line
            // belongs scrolling inside its own output block (`tool-body.tsx`) rather than dragging
            // the whole conversation sideways.
            aria-label="Conversation"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the scroll region must receive PageUp/Home/End without focusing the editor.
            tabIndex={0}
            className="chat-scroller nap-scroll relative h-full overflow-y-auto overflow-x-hidden focus-visible:outline-accent"
            style={{ paddingBottom: composerHeight, scrollPaddingBottom: composerHeight }}
          >
            {empty && loading ? (
              <TranscriptSkeleton />
            ) : empty ? (
              <EmptyState />
            ) : (
              <>
                {events.length > 0 && (
                  <ChatTranscript
                    items={transcript}
                    running={running && !workingOutside}
                    pending={pending !== undefined}
                    startedAt={startedAt}
                    seam={seam}
                    seamRef={seamRef}
                    onRetry={onRetry}
                    files={files}
                    onOpenFile={onOpenFile}
                  />
                )}
                {pending !== undefined && !pendingAfterCompaction && (
                  <PendingMessage text={pending} />
                )}
              </>
            )}

            {workingOutside && (
              <div className="mx-auto max-w-[46rem] px-5 pb-4">
                <WorkingRow startedAt={startedAt} />
              </div>
            )}
          </section>

          <div ref={composerDock} className="chat-composer-dock absolute inset-x-0 bottom-0 z-10">
            <ChatInput
              draftIdentity={draftIdentity}
              dropZone={stage}
              timeline={empty ? undefined : scroller}
              contextControl={
                <ContextControl
                  events={events}
                  running={running}
                  onCompact={() => onSubmit("/compact")}
                />
              }
              queued={
                pending !== undefined && pendingAfterCompaction
                  ? { text: pending, attachments: pendingAttachments }
                  : undefined
              }
              queueing={
                pending === undefined &&
                transcript.some((item) => item.kind === "compaction" && item.status === "running")
              }
              visible={active}
              running={running}
              error={error}
              firstPrompt={firstPrompt}
              onSubmit={onSubmit}
              onCancel={onCancel}
              {...(files === undefined ? {} : { files })}
              {...(models === undefined ? {} : { models })}
              {...(model === undefined ? {} : { model })}
              {...(onModelChange === undefined ? {} : { onModelChange })}
              {...(onAddKey === undefined ? {} : { onAddKey })}
            />
          </div>
        </div>
      </div>
    </Pane>
  );
}

/**
 * When this tab first saw the work that is open now, as a clock reading. Held by the pane rather
 * than the row because the row moves — from under the optimistic prompt into the transcript —
 * and remounts as it does, which would start a mount-time clock again from nothing.
 *
 * Keyed on the turn's `openedAt`. A turn appearing while the pane is working is the same wait
 * continuing: the logged prompt replacing the optimistic one. So is a compaction ending under the
 * request queued behind it, which the user sent to wait for it. Any other change starts the
 * reading again: one turn's `openedAt` replaced by a different one — the next turn arriving in the
 * same render as the last one's end, as a reconnect's replay can deliver them — or a turn ending
 * under some other prompt, such as a retry, which the server queues behind the running turn and
 * which is new work once that turn is over. Set during render, not in an effect, so that the first
 * frame already has it.
 */
function useWorkingSince(
  working: boolean,
  openedAt: string | undefined,
  queuedBehindCompaction: boolean,
): number | undefined {
  type Since = { at: number; key: string | undefined };
  const [since, setSince] = useState<Since | undefined>(() =>
    working ? { at: Date.now(), key: openedAt } : undefined,
  );
  let next = since;
  if (!working) next = undefined;
  else if (
    since === undefined ||
    (since.key !== undefined &&
      since.key !== openedAt &&
      (openedAt !== undefined || !queuedBehindCompaction))
  )
    next = { at: Date.now(), key: openedAt };
  else if (since.key !== openedAt) next = { at: since.at, key: openedAt };
  if (next !== since) setSince(next);
  return next?.at;
}

/** The earliest of some clock readings, as the timestamp the working row reads. */
function earliest(...readings: (number | string | undefined)[]): string | undefined {
  const times = readings
    .map((reading) => (typeof reading === "string" ? Date.parse(reading) : reading))
    .filter((time): time is number => time !== undefined && Number.isFinite(time));
  return times.length === 0 ? undefined : new Date(Math.min(...times)).toISOString();
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
    <div className="mx-auto flex max-w-[46rem] justify-end px-5 pb-4">
      <div className="chat-user-message whitespace-pre-wrap">
        <span className="sr-only">You: </span>
        {text}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 py-10 text-center">
      <NapMark className="mb-1 size-9 shrink-0 text-ink" />
      <p className="text-sm font-medium text-ink-2">Describe the app you want</p>
      <p className="max-w-[30ch] text-xs leading-relaxed text-muted">
        Start with an idea or attach a reference. We’ll take it from there.
      </p>
    </div>
  );
}

export function LiveChatPane({
  ownerId,
  active = true,
  sessionId,
  projectId,
  log,
  files,
  fetchJson,
  onOpenFile,
}: {
  ownerId?: string | undefined;
  active?: boolean;
  sessionId: string | undefined;
  /** Only so a prompt typed on the front page can be claimed by the project it was meant for. */
  projectId?: string | undefined;
  /** The workspace's one subscription, resolved above. See `useSessionLog`. */
  log: SessionLog;
  /** The project's files, for the composer's `@` menu; listed once for the whole workspace. */
  files?: readonly string[] | undefined;
  fetchJson?: FetchJson | undefined;
  /** Opens a file in the Code tab. See `ChatPane`. */
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const { events, replayed, lastSeq, jobs } = log;
  // Subscribed here rather than in `useSessionLog` with the other folds: this is the one answer
  // in the workspace that is not a fold over the log at all — it is a fact about this browser,
  // and only this pane draws it.
  const seen = useSeenCursor(sessionId, lastSeq, active);
  // Beside the cursor, and for the same reason: it is a fact about this browser rather than a
  // fold over the log, and only this pane draws it. Worked out here rather than in the pane
  // below because it needs `replayed` — a card decided before the log arrived would be a card
  // decided over an empty one.
  const { card, dismiss } = useUnseenCard(events, seen, replayed, active);
  const injected = fetchJson === undefined ? {} : { fetchJson };
  const {
    submit,
    cancel,
    pending,
    pendingAttachments,
    pendingAfterCompaction,
    running,
    startedAt,
    openedAt,
    error,
  } = useTurnSubmission({
    sessionId,
    events,
    connectionStatus: log.status,
    replayed,
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
  const [firstPrompt, setFirstPrompt] = useState<FirstPrompt>();

  // Through the same submission path as the input, so the front page's first message is an
  // ordinary turn — same optimistic message, same rate limit, same refusal wording.
  useFirstPrompt({
    projectId,
    sessionId,
    submit: (message, firstModel, attachments) => {
      // The dashboard's selected model is part of its first prompt. Put it in the workspace
      // state before sending, so the composer stays truthful for the turns that follow.
      if (firstModel !== undefined) setModel(firstModel);
      setFirstPrompt({ text: message, model: firstModel, attachments });
      void submit(message, firstModel, attachments).then((accepted) => {
        if (accepted) setFirstPrompt(undefined);
      });
    },
  });

  return (
    <>
      <ApiKeyPanel open={keyPanelOpen} onClose={() => setKeyPanelOpen(false)} keyState={key} />

      <ChatPane
        draftIdentity={ownerId && projectId ? { ownerId, projectId } : undefined}
        active={active}
        events={events}
        jobs={jobs}
        // Nothing has been asked for yet when there is no session: the project record is still on
        // its way, so the log this pane will show has not even been subscribed to.
        loading={sessionId === undefined || (!replayed && events.length === 0)}
        pending={pending}
        pendingAttachments={pendingAttachments}
        pendingAfterCompaction={pendingAfterCompaction}
        running={running}
        activity={{ startedAt, openedAt }}
        error={error}
        firstPrompt={firstPrompt}
        onOpenFile={onOpenFile}
        onSubmit={(message, attachments) => {
          setFirstPrompt(undefined);
          void submit(message, model, attachments);
        }}
        onCancel={() => void cancel()}
        // The same submission path as the input: a retry is an ordinary turn, and routing it
        // anywhere else would give it different rate-limit and optimistic-message behaviour.
        onRetry={(message, attachments) => void submit(message, model, attachments)}
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
