"use client";

/**
 * Saying something, and knowing whether the agent is still busy.
 *
 * Two rules carry this file, and both exist because the same fact arrives twice — once
 * locally the instant the user hits send, and again over the socket when the server has
 * written it down.
 *
 * **The optimistic message is held beside the transcript, never inside it.** A message has to
 * appear the moment it is typed, but the transcript is folded from `StoredEvent`s, and
 * inventing one would mean inventing a `seq` and a `turnId` — a fabricated row in the single
 * contract every part of this app agrees on. So `pending` is a string the pane renders after
 * the transcript, and it goes away when the *matching* `user.message` event arrives. Clearing
 * it on any event would make the message flicker out a frame after appearing; never clearing
 * it would show it twice, once as a guess and once as a fact.
 *
 * **Whether a turn is running is derived from the log, not remembered.** A `turn.started`
 * with no `turn.completed` or `turn.failed` after it means busy — which is still true after a
 * page reload, and true in a second tab watching the same session. A flag set on submit and
 * cleared on response would be wrong in both cases, and the way it is wrong is an input that
 * accepts a message the server is about to refuse.
 *
 * A POST in flight counts as running too: the gap between the click and the first event is
 * small, but it is exactly long enough to send the same message twice.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { useEffect, useRef, useState } from "react";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";

export type TurnSubmission = {
  /** Resolves once the server has accepted or refused; the turn itself runs on past it. */
  submit: (message: string) => Promise<void>;
  cancel: () => Promise<void>;
  /** The message the user sent that the log has not caught up with yet. */
  pending: string | undefined;
  running: boolean;
  error: string | undefined;
};

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function useTurnSubmission(options: {
  sessionId: string | undefined;
  events: readonly StoredEvent[];
  baseUrl?: string;
  fetchJson?: FetchJson;
}): TurnSubmission {
  const { sessionId, events, baseUrl = DEFAULT_BASE_URL } = options;
  const fetchJson = options.fetchJson ?? credentialedFetch;

  const [pending, setPending] = useState<string | undefined>(undefined);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const fetchRef = useRef(fetchJson);
  fetchRef.current = fetchJson;

  // Cleared by the arrival of the event it was standing in for, in an effect rather than
  // during render because it is a state change caused by new props.
  useEffect(() => {
    if (pending === undefined) return;
    const arrived = events.some(
      (event) => event.type === "user.message" && event.payload.text === pending,
    );
    if (arrived) setPending(undefined);
  }, [events, pending]);

  const submit = async (message: string): Promise<void> => {
    const text = message.trim();
    if (sessionId === undefined || text === "") return;

    setPending(text);
    setError(undefined);
    setPosting(true);

    try {
      const response = await fetchRef.current(
        `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/turns`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: text }),
        },
      );

      if (!response.ok) throw new Error(`the server answered ${response.status}`);
    } catch {
      // Rolled back rather than left on screen: a message that stays after the request failed
      // claims the agent has it. The caller puts the text back in the box.
      setPending(undefined);
      setError("That message didn't send. Try again.");
    } finally {
      setPosting(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (sessionId === undefined) return;

    try {
      // The response is deliberately not checked for success. A 409 means the turn ended
      // while the click was in flight, which is exactly what the user asked for; anything
      // else will show up as the turn continuing, which the transcript already reports.
      await fetchRef.current(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/turns/cancel`, {
        method: "POST",
      });
    } catch {
      // Nothing to say. The turn is either stopping or it is not, and the log is the
      // authority on which.
    }
  };

  return {
    submit,
    cancel,
    pending,
    running: posting || pending !== undefined || turnInFlight(events),
    error,
  };
}

/** A turn that started and has not been answered by an ending. */
function turnInFlight(events: readonly StoredEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type;
    if (type === "turn.completed" || type === "turn.failed") return false;
    if (type === "turn.started") return true;
  }
  return false;
}
