"use client";

import type { ModelChoice } from "@nap/shared/models-protocol";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { useState } from "react";
import { ChatInput } from "../chat/chat-input.tsx";
import { ChatTranscript } from "../chat/chat-transcript.tsx";
import { buildTranscript } from "../chat/transcript.ts";
import { useFirstPrompt } from "../chat/use-first-prompt.ts";
import { useModels } from "../chat/use-models.ts";
import { useTurnSubmission } from "../chat/use-turn-submission.ts";
import { WorkingIndicator } from "../chat/working-indicator.tsx";
import { turnStartedAt, workingLabel } from "../chat/working-state.ts";
import { useProjectFiles } from "../files/use-project-files.ts";
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
  files,
  models,
  model,
  onModelChange,
}: {
  events: readonly StoredEvent[];
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
}) {
  const empty = events.length === 0 && pending === undefined;

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

          {running && <Working events={events} />}
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

/**
 * The last thing on the rail while a turn is open.
 *
 * Outside the `log`, for the reason `PendingMessage` is: the transcript is folded from stored
 * events and this is not one of them — it is the *absence* of the next event, which is precisely
 * what nothing in the log can express. It wears the rail by hand so it lines up with the steps
 * above rather than floating beside them.
 */
function Working({ events }: { events: readonly StoredEvent[] }) {
  const startedAt = turnStartedAt(events);

  return (
    <div className="px-4 pb-3">
      <div className="border-edge border-l py-1 pl-4">
        <WorkingIndicator
          label={workingLabel(buildTranscript(events))}
          {...(startedAt === undefined ? {} : { startedAt })}
        />
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
  // Fed this pane's own events rather than a second subscription: the listing goes stale when
  // a turn writes a file, and this component is already told about that.
  const { listing } = useProjectFiles({ sessionId, events });
  const { models } = useModels();
  // Held here rather than in the composer: the choice has to outlive the box being cleared on
  // send, and a retry has to go out on the same model the user picked.
  const [model, setModel] = useState<string | undefined>(undefined);

  // Through the same submission path as the input, so the front page's first message is an
  // ordinary turn — same optimistic message, same rate limit, same refusal wording.
  useFirstPrompt({ projectId, sessionId, submit: (message) => void submit(message) });

  return (
    <ChatPane
      events={events}
      pending={pending}
      running={running}
      error={error}
      onSubmit={(message) => void submit(message, model)}
      onCancel={() => void cancel()}
      // The same submission path as the input: a retry is an ordinary turn, and routing it
      // anywhere else would give it different rate-limit and optimistic-message behaviour.
      onRetry={(message) => void submit(message, model)}
      files={listing?.files ?? []}
      models={models?.models ?? []}
      model={model ?? models?.fallback}
      onModelChange={setModel}
    />
  );
}
