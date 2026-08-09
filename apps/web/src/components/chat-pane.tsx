"use client";

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { ChatTranscript } from "../chat/chat-transcript.tsx";
import { useEventStream } from "../hooks/use-event-stream.ts";
import { Pane } from "./pane.tsx";

/**
 * The transcript pane: what the agent is doing, as it does it.
 *
 * Split the way the connection indicator is — the half that renders takes events as a prop and
 * is what every test mounts, and the half that subscribes owns the socket. That is what keeps
 * two dozen render tests free of the network.
 */
export function ChatPane({ events }: { events: readonly StoredEvent[] }) {
  return (
    <Pane id="chat" title="Chat">
      {events.length === 0 ? <EmptyState /> : <ChatTranscript events={events} />}
    </Pane>
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

/** Until sessions exist in the UI, the id comes from the environment — see the hook. */
const DEV_SESSION_ID = process.env.NEXT_PUBLIC_DEV_SESSION_ID;

export function LiveChatPane() {
  const { events } = useEventStream({ sessionId: DEV_SESSION_ID });

  return <ChatPane events={events} />;
}
