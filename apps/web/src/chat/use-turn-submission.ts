"use client";

import type { MediaAttachment } from "@nap/shared/media";

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
 * the transcript. Admission's request ID correlates it with its durable event or terminal
 * queue status. Text cannot identify it across clients, and a queued cancellation has no event.
 *
 * Activity follows turn identity in the log. A queue observation can retire a covered idle
 * prefix, including legacy repair turns whose original request was never recorded. This
 * changes only the activity projection; the transcript and durable history stay intact.
 *
 * A POST in flight counts as running too: the gap between the click and the first event is
 * small, but it is exactly long enough to send the same message twice.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";
import {
  SessionActivitySchema,
  TurnAcceptanceSchema,
  TurnRequestStatusSchema,
} from "@nap/shared/ports/turn-queue";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import { requestFailureCopy } from "../errors/failure-copy.ts";
import type { StreamStatus } from "../hooks/use-event-stream.ts";
import { buildTranscript } from "./transcript.ts";
import { inFlightTurn } from "./working-state.ts";

/**
 * The request never reached the server — no status, no body, so nothing above can say why.
 * Named rather than inlined so it is obvious this is the *only* copy in this file.
 */
const UNREACHABLE =
  "That message didn't reach the server. Check your connection, then send it again.";

import type { FetchJson } from "../files/use-project-files.ts";

export type TurnSubmission = {
  /** True means admission succeeded; the turn itself runs on past this response. */
  submit: (message: string, model?: string, attachments?: MediaAttachment[]) => Promise<boolean>;
  cancel: () => Promise<void>;
  /** The message the user sent that the log has not caught up with yet. */
  pending: string | undefined;
  pendingAfterCompaction: boolean;
  running: boolean;
  startedAt: string | undefined;
  error: string | undefined;
};

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

type PendingSubmission = {
  key: symbol;
  sessionId: string;
  text: string;
  afterCompaction: boolean;
} & ({ kind: "posting" | "unconfirmed" } | { kind: "accepted"; requestId: string });

/**
 * What to show when the server refuses.
 *
 * The `code` the API attaches is what makes these distinct states rather than one red line: a rate
 * limit, a sandbox quota and an expired session need three different things from the reader, and
 * the status alone does not separate them — 409 already means more than one thing in this API.
 *
 * The wording lives in `failure-copy.ts` with every other failure, so the input does not grow a
 * private vocabulary for events the transcript also describes.
 */
async function refusalMessage(response: Response): Promise<string> {
  const parsed = z
    .object({ code: z.string().optional(), error: z.string().optional() })
    .safeParse(await readJson(response));
  const code = parsed.success ? parsed.data.code : undefined;
  const message = parsed.success ? (parsed.data.error ?? "") : "";

  const copy = requestFailureCopy(response.status, code, message);
  // Title, detail and action on one line: this surfaces next to the input as a single string,
  // and the action is the half the reader can act on — dropping it would leave the sentence
  // that says a limit was hit and nothing about what to do.
  return `${copy.title} ${copy.detail} ${copy.action}`;
}

/** A body that is not JSON is a proxy's error page, or nothing at all. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export function useTurnSubmission(options: {
  sessionId: string | undefined;
  events: readonly StoredEvent[];
  baseUrl?: string;
  connectionStatus?: StreamStatus;
  replayed?: boolean;
  fetchJson?: FetchJson;
}): TurnSubmission {
  const { sessionId, events, baseUrl = DEFAULT_BASE_URL } = options;
  const fetchJson = options.fetchJson ?? credentialedFetch;

  const [pending, setPending] = useState<PendingSubmission>();
  const [activity, setActivity] = useState<{
    sessionId: string;
    idleThroughSeq: number;
    active: boolean;
  }>();
  const [error, setError] = useState<string | undefined>(undefined);
  const active = useRef<symbol | undefined>(undefined);
  const sessionRef = useRef(sessionId);
  const previousSession = useRef(sessionId);
  sessionRef.current = sessionId;
  const cursor = events.findLast((event) => event.sessionId === sessionId)?.seq ?? 0;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  const fetchRef = useRef(fetchJson);
  fetchRef.current = fetchJson;

  useEffect(() => {
    if (previousSession.current === sessionId) return;
    previousSession.current = sessionId;
    active.current = undefined;
    setPending(undefined);
    setError(undefined);
    setActivity(undefined);
  }, [sessionId]);

  // Admission's ID also names the first turn. Text is not an identity across clients.
  // Read the whole replay so an event arriving before the POST response still acknowledges it.
  useEffect(() => {
    if (pending?.kind !== "accepted") return;
    const arrived = events.some(
      (event) =>
        event.sessionId === pending.sessionId &&
        event.turnId === pending.requestId &&
        (event.type === "user.message" ||
          event.type === "turn.failed" ||
          event.type === "turn.completed" ||
          (pending.text === "/compact" && event.type === "compaction.started")),
    );
    if (arrived) setPending((current) => (current?.key === pending.key ? undefined : current));
  }, [events, pending]);

  // A cancelled queued row never produces a user.message. Only that exact row's terminal
  // status can settle it; the active compaction's failure says nothing about a later prompt.
  useEffect(() => {
    if (pending?.kind !== "accepted") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const reconcile = async (): Promise<void> => {
      let settled = false;
      try {
        const response = await fetchRef.current(
          `${baseUrl}/sessions/${encodeURIComponent(pending.sessionId)}/turns/${encodeURIComponent(pending.requestId)}`,
          { signal: controller.signal },
        );
        const parsed = TurnRequestStatusSchema.safeParse(await readJson(response));
        if (
          !controller.signal.aborted &&
          response.ok &&
          parsed.success &&
          parsed.data.id === pending.requestId &&
          (parsed.data.state === "done" ||
            parsed.data.state === "failed" ||
            parsed.data.state === "orphaned")
        ) {
          settled = true;
          setPending((current) => (current?.key === pending.key ? undefined : current));
        }
      } catch {
        // A disconnected read does not establish that accepted work has ended.
      }
      if (!controller.signal.aborted && !settled)
        timer = setTimeout(() => {
          void reconcile();
        }, 1000);
    };
    timer = setTimeout(() => {
      void reconcile();
    }, 1000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [baseUrl, pending]);

  // One bounded read loop serves both controls and the elapsed clock. Only an idle
  // observation retires history, and only up to its server-verified event cursor.
  const pendingKey = pending?.key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: admission and reconnect/replay changes invalidate outstanding observations even without a new event cursor.
  useEffect(() => {
    if (sessionId === undefined) return;
    let stopped = false;
    let controller: AbortController | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const reconcile = async (): Promise<void> => {
      controller = new AbortController();
      const request = controller;
      const generation = active.current;
      const observedCursor = cursorRef.current;
      deadline = setTimeout(() => request.abort(), 5000);
      try {
        const response = await fetchRef.current(
          `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/activity?cursor=${observedCursor}`,
          { signal: request.signal },
        );
        const parsed = SessionActivitySchema.safeParse(await readJson(response));
        if (
          !stopped &&
          !request.signal.aborted &&
          response.ok &&
          parsed.success &&
          sessionRef.current === sessionId &&
          active.current === generation &&
          cursorRef.current === observedCursor &&
          parsed.data.sessionId === sessionId &&
          parsed.data.throughSeq >= observedCursor
        ) {
          const observation = parsed.data;
          setActivity((previous) => ({
            sessionId,
            active: observation.active,
            idleThroughSeq: Math.max(
              previous?.sessionId === sessionId ? previous.idleThroughSeq : 0,
              observation.active ? 0 : observation.throughSeq,
            ),
          }));
        }
      } catch {
        // Failure establishes no new idle prefix. Retain any earlier observed active work.
      } finally {
        clearTimeout(deadline);
        if (!stopped)
          timer = setTimeout(() => {
            void reconcile();
          }, 1000);
      }
    };
    // Coalesce mount/replay/admission updates without issuing a read per streamed event.
    timer = setTimeout(() => {
      void reconcile();
    }, 1000);
    return () => {
      stopped = true;
      controller?.abort();
      clearTimeout(timer);
      clearTimeout(deadline);
    };
  }, [baseUrl, sessionId, pendingKey, options.connectionStatus, options.replayed]);

  const submit = async (
    message: string,
    model?: string,
    attachments?: MediaAttachment[],
  ): Promise<boolean> => {
    const text = message.trim();
    if (sessionId === undefined || text === "") return false;

    const key = Symbol();
    active.current = key;
    setPending({
      key,
      sessionId,
      text,
      kind: "posting",
      afterCompaction:
        turn !== undefined &&
        buildTranscript(events.filter((event) => event.sessionId === sessionId)).some(
          (item) =>
            item.kind === "compaction" && item.turnId === turn.turnId && item.status === "running",
        ),
    });
    setError(undefined);

    try {
      const response = await fetchRef.current(
        `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/turns`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          // An unchosen model leaves the key out rather than sending null, which the route
          // would refuse: `JSON.stringify` drops undefined properties, so this one expression
          // produces both bodies. An explicit branch here reads as though it were doing
          // something, and no test could tell the two apart.
          body: JSON.stringify({ message: text, model, attachments }),
        },
      );

      if (!response.ok) throw new Error(await refusalMessage(response));
      const accepted = TurnAcceptanceSchema.safeParse(await readJson(response));
      if (active.current !== key || sessionRef.current !== sessionId) return true;
      if (!accepted.success) {
        // A successful but malformed receipt may already have queued the work. Do not invite
        // a duplicate send by reporting admission failure or correlating it with another turn.
        setPending((current) =>
          current?.key === key ? { ...current, kind: "unconfirmed" } : current,
        );
        setError(
          "The server accepted the message, but its status could not be read. Reload to check it.",
        );
        return true;
      }
      setPending((current) =>
        current?.key === key
          ? { ...current, kind: "accepted", requestId: accepted.data.requestId }
          : current,
      );
      return true;
    } catch (failure) {
      // Rolled back rather than left on screen: a message that stays after the request failed
      // claims the agent has it. The caller puts the text back in the box.
      if (active.current === key && sessionRef.current === sessionId) {
        setPending(undefined);
        setError(failure instanceof Error ? failure.message : UNREACHABLE);
      }
      return false;
    }
  };

  const cancel = async (): Promise<void> => {
    if (sessionId === undefined) return;

    try {
      // Cancellation races admission on the server. Its response cannot tell which pending
      // prompt it covered; the exact request status above is authoritative, even in this tab.
      await fetchRef.current(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/turns/cancel`, {
        method: "POST",
      });
    } catch {
      // The log and pending request status still determine whether the work ended.
    }
  };

  const observation = activity?.sessionId === sessionId ? activity : undefined;
  const turn = inFlightTurn(
    events.filter((event) => event.sessionId === sessionId),
    observation?.idleThroughSeq,
  );

  return {
    submit,
    cancel,
    pending: pending?.sessionId === sessionId ? pending?.text : undefined,
    pendingAfterCompaction: pending?.sessionId === sessionId && pending?.afterCompaction === true,
    running:
      (pending !== undefined && pending.sessionId === sessionId) ||
      observation?.active === true ||
      turn !== undefined,
    startedAt: turn?.startedAt,
    error,
  };
}
