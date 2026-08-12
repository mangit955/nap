"use client";

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { ChatInput } from "../chat/chat-input.tsx";
import { ChatTranscript } from "../chat/chat-transcript.tsx";
import { buildTranscript } from "../chat/transcript.ts";
import { useFirstPrompt } from "../chat/use-first-prompt.ts";
import { useTurnSubmission } from "../chat/use-turn-submission.ts";
import { turnStartedAt, workingLabel } from "../chat/working-state.ts";
import { useEventStream } from "../hooks/use-event-stream.ts";
import { Pane } from "./pane.tsx";

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
  pending,
  running = false,
  error,
  onSubmit = () => {},
  onCancel = () => {},
  onRetry,
}: {
  events: readonly StoredEvent[];
  pending?: string | undefined;
  running?: boolean;
  error?: string | undefined;
  onSubmit?: (message: string) => void;
  onCancel?: () => void;
  /** Re-sends a failed turn's message. Optional so the many render tests need not supply one. */
  onRetry?: ((message: string) => void) | undefined;
}) {
  const empty = events.length === 0 && pending === undefined;
  const startedAt = turnStartedAt(events);

  return (
    <Pane id="chat" title="Chat">
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-auto">
          {empty ? (
            <EmptyState />
          ) : (
            <>
              {events.length > 0 && <ChatTranscript events={events} onRetry={onRetry} />}
              {pending !== undefined && <PendingMessage text={pending} />}
            </>
          )}
        </div>

        {/*
          The indicator's copy is derived here rather than in the input, from the same fold the
          rail is drawn from — so what the footer says and what the steps above it show can
          never be two different accounts of one turn. The input itself stays ignorant of
          events, which is what keeps its own tests free of event fixtures.
        */}
        <ChatInput
          running={running}
          error={error}
          onSubmit={onSubmit}
          onCancel={onCancel}
          label={workingLabel(buildTranscript(events))}
          {...(startedAt === undefined ? {} : { startedAt })}
        />
      </div>
    </Pane>
  );
}

/**
 * The message the user just sent, before the log has caught up with it.
 *
 * Drawn exactly like a stored user message — same rail, same face — because it *is* the same
 * message. A differently-styled placeholder that swaps for the real thing a moment later is a
 * flicker with no meaning behind it.
 */
function PendingMessage({ text }: { text: string }) {
  return (
    <div className="px-4 pb-3">
      <div className="border-edge border-l pl-4">
        <p className="whitespace-pre-wrap text-ink text-sm leading-relaxed">
          <span className="sr-only">You: </span>
          {text}
        </p>
      </div>
    </div>
  );
}

/** An empty screen is an invitation, so it says what to do rather than what this is. */
function EmptyState() {
  return (
    <div className="p-4">
      <p className="text-muted text-sm leading-relaxed">
        Describe the app you want. Every file the agent writes and every command it runs shows up
        here as it happens.
      </p>
    </div>
  );
}

export function LiveChatPane({
  sessionId,
  projectId,
}: {
  sessionId: string | undefined;
  /** Only so a prompt typed on the front page can be claimed by the project it was meant for. */
  projectId?: string | undefined;
}) {
  const { events } = useEventStream({ sessionId });
  const { submit, cancel, pending, running, error } = useTurnSubmission({ sessionId, events });

  // Through the same submission path as the input, so the front page's first message is an
  // ordinary turn — same optimistic message, same rate limit, same refusal wording.
  useFirstPrompt({ projectId, sessionId, submit: (message) => void submit(message) });

  return (
    <ChatPane
      events={events}
      pending={pending}
      running={running}
      error={error}
      onSubmit={(message) => void submit(message)}
      onCancel={() => void cancel()}
      // The same submission path as the input: a retry is an ordinary turn, and routing it
      // anywhere else would give it different rate-limit and optimistic-message behaviour.
      onRetry={(message) => void submit(message)}
    />
  );
}
