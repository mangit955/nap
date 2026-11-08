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
 * contract every part of this app agrees on. So `pending` is a string the pane renders beside
 * the transcript or in the attached queue. Admission's request ID correlates it with its
 * durable event or terminal queue status. Text cannot identify it across clients, and a
 * queued cancellation has no event.
 *
 * Activity follows turn identity in the log. A queue observation can retire a covered idle
 * prefix, including legacy repair turns whose original request was never recorded. This
 * changes only the activity projection; the transcript and durable history stay intact.
 *
 * A POST in flight counts as running too: the gap between the click and the first event is
 * small, but it is exactly long enough to send the same message twice.
 */

import type { PlanIntent } from "@nap/shared/agent-plan";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { SteerAcceptanceSchema } from "@nap/shared/ports/steer-queue";
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
  submit: (
    message: string,
    model?: string,
    attachments?: MediaAttachment[],
    /** Asking for a plan, or approving one (ADR-0025). Absent is an ordinary turn. */
    plan?: PlanIntent,
    /** The app test this prompt fixes, by turn id: what Fix it sends. */
    fixesTest?: string,
  ) => Promise<boolean>;
  startTest: (jobId: string, model?: string) => Promise<boolean>;
  cancel: () => Promise<void>;
  /** The message the user sent that the log has not caught up with yet. */
  pending: string | undefined;
  /**
   * A message sent into the running turn (ADR-0028) that the log has not caught up with yet. Kept
   * apart from `pending` because it is not a prompt waiting for a turn: the turn answering it is
   * already running, and its place is with the transcript's own waiting steers, not under it.
   */
  pendingSteer: string | undefined;
  pendingAttachments: MediaAttachment[] | undefined;
  pendingAfterCompaction: boolean;
  running: boolean;
  idleThroughSeq: number;
  testPhase: "idle" | "starting" | "running";
  startedAt: string | undefined;
  /** When the turn in flight was first written to the log; see `InFlightTurn`. */
  openedAt: string | undefined;
  error: string | undefined;
};

export type TurnActivity = Pick<TurnSubmission, "running" | "idleThroughSeq"> & {
  sessionId: string | undefined;
};

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

type PendingSubmission = {
  purpose: "message" | "test" | "steer";
  key: symbol;
  sessionId: string;
  text: string;
  attachments: MediaAttachment[] | undefined;
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
        // A steer is acknowledged by any record of it — waiting, read, or given back — or by the
        // turn it became, which carries its id.
        (((event.type === "steer.received" ||
          event.type === "steer.applied" ||
          event.type === "steer.dropped") &&
          event.payload.steerId === pending.requestId) ||
          (event.turnId === pending.requestId &&
            (event.type === "user.message" ||
              event.type === "test.started" ||
              event.type === "turn.failed" ||
              event.type === "turn.completed" ||
              (pending.text === "/compact" && event.type === "compaction.started")))),
    );
    if (arrived) setPending((current) => (current?.key === pending.key ? undefined : current));
  }, [events, pending]);

  // A cancelled queued row never produces a user.message. Only that exact row's terminal
  // status can settle it; the active compaction's failure says nothing about a later prompt.
  useEffect(() => {
    // A steer has no request row to ask about until it becomes a turn, and then its prompt says so.
    if (pending?.kind !== "accepted" || pending.purpose === "steer") return;
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

  const admit = async (
    intent:
      | {
          kind: "message";
          message: string;
          attachments?: MediaAttachment[] | undefined;
          plan?: PlanIntent | undefined;
          fixesTest?: string | undefined;
        }
      | { kind: "test"; jobId: string },
    model?: string,
  ): Promise<boolean> => {
    const text = intent.kind === "test" ? "Test the app" : intent.message.trim();
    const attachments = intent.kind === "message" ? intent.attachments : undefined;
    if (sessionId === undefined || text === "") return false;
    const compacting =
      intent.kind === "message" &&
      turn !== undefined &&
      buildTranscript(events.filter((event) => event.sessionId === sessionId)).some(
        (item) =>
          item.kind === "compaction" && item.turnId === turn.turnId && item.status === "running",
      );
    // Into the running turn, if one is running and this is words alone (ADR-0028). Images, a
    // `/compact` and a plan approval are each a turn of their own, so those still queue behind it,
    // as does anything sent while a compaction runs, which takes no steers.
    const steer =
      intent.kind === "message" &&
      !compacting &&
      (turn !== undefined || observation?.active === true) &&
      (attachments?.length ?? 0) === 0 &&
      text !== "/compact" &&
      intent.plan?.intent !== "approve" &&
      // A Fix it opens a job of its own, judged by the test it names: never part of another turn.
      intent.fixesTest === undefined;
    // The message's identity whichever way the server places it, chosen here so a retried POST is
    // the same message rather than a second one.
    const id = crypto.randomUUID();

    const key = Symbol();
    active.current = key;
    setPending({
      purpose: steer ? "steer" : intent.kind,
      key,
      sessionId,
      text,
      attachments,
      kind: "posting",
      afterCompaction: compacting,
    });
    setError(undefined);

    try {
      const response = await fetchRef.current(
        `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/${intent.kind === "test" ? "tests" : steer ? "steers" : "turns"}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          // An unchosen model leaves the key out rather than sending null, which the route
          // would refuse: `JSON.stringify` drops undefined properties, so this one expression
          // produces both bodies. An explicit branch here reads as though it were doing
          // something, and no test could tell the two apart.
          body: JSON.stringify(
            intent.kind === "test"
              ? { jobId: intent.jobId, model }
              : steer
                ? { id, message: text, model, plan: intent.plan }
                : {
                    message: text,
                    model,
                    attachments,
                    plan: intent.plan,
                    fixesTest: intent.fixesTest,
                  },
          ),
        },
      );

      if (!response.ok) throw new Error(await refusalMessage(response));
      const receipt = await readJson(response);
      const accepted = TurnAcceptanceSchema.safeParse(receipt);
      // Where the server put a steer: into the turn, or queued as the next one, which is then a
      // prompt waiting like any other.
      const landed = steer ? SteerAcceptanceSchema.safeParse(receipt) : undefined;
      if (active.current !== key || sessionRef.current !== sessionId) return true;
      if (!accepted.success || landed?.success === false) {
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
          ? {
              ...current,
              ...(landed?.success === true && landed.data.as === "turn"
                ? { purpose: "message" as const }
                : {}),
              kind: "accepted",
              requestId: accepted.data.requestId,
            }
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

  const submit: TurnSubmission["submit"] = (message, model, attachments, plan, fixesTest) =>
    admit({ kind: "message", message, attachments, plan, fixesTest }, model);
  const startTest: TurnSubmission["startTest"] = (jobId, model) =>
    admit({ kind: "test", jobId }, model);

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
  const testIsRunning =
    turn !== undefined &&
    events.some(
      (event) =>
        event.sessionId === sessionId &&
        event.turnId === turn.turnId &&
        event.type === "test.started",
    );

  return {
    submit,
    idleThroughSeq: observation?.idleThroughSeq ?? 0,
    startTest,
    cancel,
    pending:
      pending?.sessionId === sessionId && pending?.purpose === "message" ? pending.text : undefined,
    pendingSteer:
      pending?.sessionId === sessionId && pending?.purpose === "steer" ? pending.text : undefined,
    pendingAttachments: pending?.sessionId === sessionId ? pending?.attachments : undefined,
    pendingAfterCompaction: pending?.sessionId === sessionId && pending?.afterCompaction === true,
    running:
      (pending !== undefined && pending.sessionId === sessionId) ||
      observation?.active === true ||
      turn !== undefined,
    testPhase: testIsRunning
      ? "running"
      : pending?.sessionId === sessionId && pending?.purpose === "test"
        ? "starting"
        : "idle",
    startedAt: turn?.startedAt,
    openedAt: turn?.openedAt,
    error,
  };
}
