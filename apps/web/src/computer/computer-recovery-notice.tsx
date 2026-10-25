"use client";

import {
  ComputerAbandonResultSchema,
  ComputerRecoveryStatusSchema,
} from "@nap/shared/computer-access";
import { useCallback, useEffect, useState } from "react";
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
const RefusalSchema = z.object({
  error: z.string().max(300),
  abandonableAt: z.int().nonnegative().optional(),
});

/**
 * Shown when the project is paused because its computer never confirmed that an action
 * finished. Owner-only: the API answers nothing about somebody else's session.
 */
export function ComputerRecoveryNotice({
  sessionId,
  fetch: fetchJson = credentialedFetch,
  confirm = (message) => window.confirm(message),
}: {
  sessionId: string | undefined;
  fetch?: FetchJson;
  confirm?: (message: string) => boolean;
}) {
  const [abandonableAt, setAbandonableAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = sessionId
    ? `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/computer`
    : undefined;

  useEffect(() => {
    if (!base) return;
    let alive = true;
    const check = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const response = await fetchJson(`${base}/recovery`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) return;
        const status = ComputerRecoveryStatusSchema.safeParse(await response.json());
        if (!alive || !status.success) return;
        setAbandonableAt(status.data.stuck ? status.data.abandonableAt : null);
        setNow(Date.now());
      } catch {
        // A failed check changes nothing: the next one will say whether the pause is real.
      }
    };
    void check();
    const timer = setInterval(() => void check(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
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
    setBusy(true);
    setError(null);
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
        setAbandonableAt(null);
        setOutcome(
          result.data.outcome === "recovered"
            ? "The computer responded after all, so nothing was lost. Nap can carry on."
            : "Nap stopped using that computer. Your next message starts a fresh computer from your last saved version.",
        );
        return;
      }
      const refusal = RefusalSchema.safeParse(body);
      if (refusal.success && refusal.data.abandonableAt !== undefined)
        setAbandonableAt(refusal.data.abandonableAt);
      setError(refusal.success ? refusal.data.error : "Nap could not abandon this computer.");
    } catch {
      setError("Nap could not abandon this computer. Try again.");
    } finally {
      setBusy(false);
      setNow(Date.now());
    }
  }, [base, confirm, fetchJson]);

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
      <section className="app-test-card" aria-label="Computer paused">
        <h3>Nap's computer stopped responding</h3>
        <p>
          It stopped in the middle of an action, so Nap paused this project rather than risk
          repeating that action. New messages wait until this is resolved.
        </p>
        <button
          type="button"
          className="app-test-primary"
          disabled={waiting || busy}
          onClick={() => void abandon()}
        >
          Abandon this computer
        </button>
        {waiting && (
          <p className="app-test-reason">
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
