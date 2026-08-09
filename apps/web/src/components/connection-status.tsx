"use client";

/**
 * Whether the transcript in front of you is still live.
 *
 * A dropped stream is the one failure a user cannot diagnose by looking at the page: the
 * chat simply stops, and nothing distinguishes "the agent is thinking" from "the connection
 * died four minutes ago". So the state is named in text inside a live region rather than
 * signalled by the colour of a dot, which also makes it findable by a screen reader.
 *
 * Split in two: the presentational half takes a status and is what the tests render, and the
 * live half owns the subscription. Keeping them apart is what lets the states be exercised
 * without a socket.
 */

import { type StreamStatus, useEventStream } from "../hooks/use-event-stream.ts";

export const STATUS_LABELS: Record<StreamStatus, string> = {
  idle: "no session",
  connecting: "connecting…",
  open: "live",
  reconnecting: "reconnecting…",
};

const STATUS_DOT: Record<StreamStatus, string> = {
  idle: "bg-muted",
  connecting: "bg-muted animate-pulse",
  open: "bg-accent",
  reconnecting: "bg-muted animate-pulse",
};

export function ConnectionStatus({ status }: { status: StreamStatus }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2">
      <span className={`size-1.5 rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" />
      <span className="text-muted text-xs">{STATUS_LABELS[status]}</span>
    </div>
  );
}

export function LiveConnectionStatus({ sessionId }: { sessionId: string | undefined }) {
  const { status } = useEventStream({ sessionId });

  return <ConnectionStatus status={status} />;
}
