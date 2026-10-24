import { TurnAcceptanceSchema, TurnRequestStatusSchema } from "@nap/shared/ports/turn-queue";
import { useCallback, useEffect, useReducer, useState } from "react";
import { z } from "zod";
import type { FetchJson } from "../files/use-project-files.ts";

const receiptSchema = TurnAcceptanceSchema.pick({ requestId: true });
const refusalSchema = z.object({ error: z.string() });
const admissionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("posting"), token: z.uuid() }),
  z.object({ kind: z.literal("accepted"), token: z.uuid(), requestId: z.uuid() }),
  z.object({ kind: z.literal("recovery"), token: z.uuid() }),
]);
type Admission = z.infer<typeof admissionSchema>;
const changed = "nap:publication-admission-changed";
// Keep the same ownership across card mounts even when the browser refuses session storage.
const withoutStorage = new Map<string, Admission | null>();
const posting = new Set<string>();

function read(key: string): Admission | undefined {
  if (withoutStorage.has(key)) return withoutStorage.get(key) ?? undefined;
  try {
    const parsed = admissionSchema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? "null"));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, admission: Admission | undefined): void {
  try {
    if (admission) sessionStorage.setItem(key, JSON.stringify(admission));
    else sessionStorage.removeItem(key);
    withoutStorage.delete(key);
  } catch {
    withoutStorage.set(key, admission ?? null);
  }
  window.dispatchEvent(new Event(changed));
}

async function json(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined);
}

/** Admission belongs to the job, not the conditionally mounted card that starts its POST. */
export function usePublicationAdmission(options: {
  baseUrl: string;
  projectId: string;
  sessionId: string | undefined;
  userId: string | undefined;
  jobId: string | undefined;
  fetchJson: FetchJson;
  reload: () => Promise<{ ok: true; applied: boolean } | { ok: false; error: string }>;
}) {
  const { baseUrl, projectId, sessionId, userId, jobId, fetchJson, reload } = options;
  // Versioned separately from the old timestamp markers, which cannot identify a request.
  const key =
    sessionId && userId && jobId
      ? `nap:publication-admission:v2:${JSON.stringify([baseUrl, userId, projectId, sessionId, jobId])}`
      : undefined;
  const [, update] = useReducer((revision: number) => revision + 1, 0);
  const [failure, setFailure] = useState<{ key: string; error: string }>();
  const error = failure?.key === key ? failure?.error : undefined;
  const admission = key ? read(key) : undefined;
  const requestId = admission?.kind === "accepted" ? admission.requestId : undefined;
  const clearError = useCallback(() => setFailure(undefined), []);

  useEffect(() => {
    window.addEventListener(changed, update);
    return () => window.removeEventListener(changed, update);
  }, []);
  useEffect(() => {
    if (!key) return;
    const current = read(key);
    // A document reload lost the POST continuation. Its outcome needs explicit recovery.
    if (current?.kind === "posting" && !posting.has(current.token))
      write(key, { kind: "recovery", token: current.token });
  }, [key]);

  const publish = async () => {
    if (!key || !jobId || read(key)) return;
    const token = crypto.randomUUID();
    posting.add(token);
    // Persist before sending. A late response continues to own this token after unmount.
    write(key, { kind: "posting", token });
    clearError();
    try {
      const response = await fetchJson(`${baseUrl}/projects/${projectId}/github/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      const body = await json(response);
      if (read(key)?.token !== token) return;
      const refusal = refusalSchema.safeParse(body);
      if (
        !response.ok &&
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        refusal.success
      ) {
        write(key, undefined);
        setFailure({ key, error: refusal.data.error });
        return;
      }
      const receipt = receiptSchema.safeParse(body);
      write(
        key,
        response.ok && receipt.success
          ? { kind: "accepted", token, requestId: receipt.data.requestId }
          : { kind: "recovery", token },
      );
    } catch {
      // A missing response does not prove that admission failed. Recovery stays explicit.
      if (read(key)?.token === token) write(key, { kind: "recovery", token });
    } finally {
      posting.delete(token);
    }
  };

  const check = useCallback(
    async (signal: AbortSignal, manual: boolean): Promise<string | undefined> => {
      const current = key ? read(key) : undefined;
      let terminal = false;
      if (current?.kind === "accepted" && sessionId) {
        try {
          const response = await fetchJson(
            `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(current.requestId)}`,
            { signal },
          );
          const status = TurnRequestStatusSchema.safeParse(await json(response));
          if (signal.aborted) return;
          if (!response.ok || !status.success || status.data.id !== current.requestId)
            return "Could not confirm publication status. Open Pull requests to check or retry.";
          terminal =
            status.data.state === "done" ||
            status.data.state === "failed" ||
            status.data.state === "orphaned";
        } catch {
          return "Could not confirm publication status. Open Pull requests to check or retry.";
        }
      }
      if (signal.aborted || (!manual && !terminal)) return;
      const result = await reload();
      if (signal.aborted) return;
      if (!result.ok) return result.error;
      // A superseded refresh did not update the job, so it cannot rearm controls.
      if (result.applied && terminal && key && read(key)?.token === current?.token)
        write(key, undefined);
      return undefined;
    },
    [key, baseUrl, sessionId, fetchJson, reload],
  );

  useEffect(() => {
    if (!requestId) return;
    void reload();
    let stopped = false;
    let controller: AbortController | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const request = new AbortController();
      controller = request;
      deadline = setTimeout(() => request.abort(), 5000);
      await check(request.signal, false);
      clearTimeout(deadline);
      if (!stopped) timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      stopped = true;
      controller?.abort();
      clearTimeout(deadline);
      clearTimeout(timer);
    };
  }, [requestId, check, reload]);

  const checkPublication = async () => {
    clearError();
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 5000);
    const failure = await check(controller.signal, true);
    clearTimeout(deadline);
    if (key && failure) setFailure({ key, error: failure });
  };

  return {
    pending: admission !== undefined,
    queued: admission?.kind === "accepted",
    error,
    clearError,
    publish,
    checkPublication,
  };
}
