"use client";

import {
  ComputerAbandonResultSchema,
  ComputerRecoveryStatusSchema,
} from "@nap/shared/computer-access";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
// Rare and slow to change: a project pauses only after a lost reply, and stays paused for
// minutes. A tighter loop would cost every open tab a query to learn nothing.
const POLL_MS = 30_000;
const WARNING =
  "Abandon this computer? Nap will start a fresh computer from your last saved version. " +
  "Changes made since then may be lost.";
const OUTCOMES = {
  recovered: "The computer responded after all, so nothing was lost. Nap can carry on.",
  abandoned:
    "Nap stopped using that computer. Your next message starts a fresh computer from your last saved version.",
  // Usually the reaper reached the computer first. This request gave nothing up either way.
  clear: "Nothing was holding this computer any more, so nothing was abandoned or lost.",
} as const;
// The server may have committed the abandon after the request timed out. The log says so if it
// did, because an abandon is written into the conversation.
const UNCERTAIN = "Nap could not confirm whether it abandoned the computer. Checking again…";
const STILL_PAUSED = "Nap could not abandon the computer, and it is still paused. Try again.";
const UNCERTAIN_CLEARED =
  "This computer is no longer paused. If Nap abandoned it, a note in the conversation says so.";
const RefusalSchema = z.object({
  error: z.string().max(300),
  abandonableAt: z.int().nonnegative().optional(),
});

/**
 * Shown when the project is paused because its computer never confirmed that an action
 * finished. Owner-only: the API answers nothing about somebody else's session.
 *
 * `onChange` hears a new value whenever what this shows changes, so the transcript it sits at
 * the end of can keep a reader who was at the bottom there: nothing else in the transcript moves
 * when a paused project starts explaining itself.
 */
export function ComputerRecoveryNotice({
  sessionId,
  fetch: fetchJson = credentialedFetch,
  confirm = (message) => window.confirm(message),
  onChange,
}: {
  sessionId: string | undefined;
  fetch?: FetchJson;
  confirm?: (message: string) => boolean;
  onChange?: ((shown: string) => void) | undefined;
}) {
  const [abandonableAt, setAbandonableAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  // Bumped when an abandon starts and when it ends, so a check that was already in flight cannot
  // bring back a pause the abandon has since resolved.
  const generation = useRef(0);
  // Whether the last answer said stuck, so a change can retire text about the earlier pause.
  const stuck = useRef(false);
  // Set by an abandon whose answer never arrived, until a check says how it ended.
  const uncertain = useRef(false);
  const checkNow = useRef<() => void>(() => {});
  const base = sessionId
    ? `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/computer`
    : undefined;

  useEffect(() => {
    if (!base) return;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const check = async () => {
      if (document.visibilityState === "hidden") return;
      const asked = generation.current;
      try {
        const response = await fetchJson(`${base}/recovery`, {
          credentials: "include",
          cache: "no-store",
        });
        // Not composed on this deployment, or not this caller's session: asking again won't help.
        if (response.status === 404) {
          clearInterval(timer);
          return;
        }
        if (!response.ok) return;
        const status = ComputerRecoveryStatusSchema.safeParse(await response.json());
        if (!alive || !status.success || asked !== generation.current) return;
        if (status.data.stuck !== stuck.current) {
          stuck.current = status.data.stuck;
          setOutcome(!status.data.stuck && uncertain.current ? UNCERTAIN_CLEARED : null);
          setError(null);
        } else if (uncertain.current && status.data.stuck) setError(STILL_PAUSED);
        uncertain.current = false;
        setAbandonableAt(status.data.stuck ? status.data.abandonableAt : null);
        setNow(Date.now());
      } catch {
        // A failed check changes nothing: the next one will say whether the pause is real.
      }
    };
    checkNow.current = () => void check();
    void check();
    timer = setInterval(() => void check(), POLL_MS);
    // Coming back to the tab is when the owner looks, so it should not wait for the next tick.
    const visible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      alive = false;
      checkNow.current = () => {};
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [base, fetchJson]);

  // Re-render when the wait is over, so the button enables without another poll.
  useEffect(() => {
    if (abandonableAt === null || abandonableAt <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), abandonableAt - now);
    return () => clearTimeout(timer);
  }, [abandonableAt, now]);

  const abandon = useCallback(async () => {
    if (!base || !confirm(WARNING)) return;
    generation.current += 1;
    setBusy(true);
    setError(null);
    let recheck = false;
    try {
      const response = await fetchJson(`${base}/abandon`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body: unknown = await response.json().catch(() => null);
      const result = ComputerAbandonResultSchema.safeParse(body);
      if (response.ok && result.success) {
        stuck.current = false;
        setAbandonableAt(null);
        setOutcome(OUTCOMES[result.data.outcome]);
        return;
      }
      if (response.status >= 500) {
        uncertain.current = true;
        recheck = true;
        setError(UNCERTAIN);
        return;
      }
      const refusal = RefusalSchema.safeParse(body);
      if (refusal.success && refusal.data.abandonableAt !== undefined)
        setAbandonableAt(refusal.data.abandonableAt);
      setError(refusal.success ? refusal.data.error : "Nap could not abandon this computer.");
    } catch {
      uncertain.current = true;
      recheck = true;
      setError(UNCERTAIN);
    } finally {
      generation.current += 1;
      setBusy(false);
      setNow(Date.now());
      if (recheck) checkNow.current();
    }
  }, [base, confirm, fetchJson]);

  const shown = `${abandonableAt !== null}:${busy}:${outcome ?? ""}:${error ?? ""}`;
  const report = useRef(onChange);
  report.current = onChange;
  useLayoutEffect(() => {
    report.current?.(shown);
  }, [shown]);

  if (abandonableAt === null)
    return outcome ? (
      <div className="app-test-cards">
        <p className="app-test-reason" role="status">
          {outcome}
        </p>
      </div>
    ) : null;
  const waiting = abandonableAt > now;
  return (
    <div className="app-test-cards">
      <section className="app-test-card" aria-label="Computer paused" aria-busy={busy}>
        <h3>Nap's computer stopped responding</h3>
        <p>
          It stopped in the middle of an action, so Nap paused this project rather than risk
          repeating that action. New messages wait until this is resolved.
        </p>
        <button
          type="button"
          className="app-test-primary"
          disabled={waiting || busy}
          aria-describedby={waiting ? reasonId : undefined}
          onClick={() => void abandon()}
        >
          {busy ? "Abandoning…" : "Abandon this computer"}
        </button>
        {waiting && (
          <p className="app-test-reason" id={reasonId}>
            Nap is still trying to reach it. You can abandon it from{" "}
            {new Date(abandonableAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
            .
          </p>
        )}
        {error && (
          <p className="app-test-reason" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
