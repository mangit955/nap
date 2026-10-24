"use client";

import { type ComputerStream, ComputerStreamSchema } from "@nap/shared/computer-access";
import { useEffect, useState } from "react";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";

type StreamState =
  | { status: "idle" | "loading" | "error" }
  | { status: "ready"; credentials: ComputerStream };
const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** Credentials live only in this visible desktop generation, never in the session log. */
export function useDesktopStream({
  sessionId,
  sandboxId,
  active,
  fetchJson = credentialedFetch,
}: {
  sessionId: string | undefined;
  sandboxId: string | undefined;
  active: boolean;
  fetchJson?: FetchJson | undefined;
}) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ identity: string; state: StreamState } | null>(null);
  const identity =
    active && sessionId && sandboxId ? JSON.stringify([sessionId, sandboxId, attempt]) : null;
  useEffect(() => {
    if (!identity || !sessionId) {
      setResult(null);
      return;
    }
    const controller = new AbortController();
    let current = true;
    setResult({ identity, state: { status: "loading" } });
    void (async () => {
      try {
        const response = await fetchJson(
          `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/computer/stream`,
          { credentials: "include", cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) throw new Error("Stream unavailable");
        const credentials = ComputerStreamSchema.parse(await response.json());
        if (credentials.width !== 1024 || credentials.height !== 768)
          throw new Error("Unexpected screen size");
        if (current) setResult({ identity, state: { status: "ready", credentials } });
      } catch {
        if (current) setResult({ identity, state: { status: "error" } });
      }
    })();
    return () => {
      current = false;
      controller.abort();
    };
  }, [identity, sessionId, fetchJson]);
  const state: StreamState =
    identity === null
      ? { status: "idle" }
      : result?.identity === identity
        ? result.state
        : { status: "loading" };
  return { state, generation: identity, retry: () => setAttempt((value) => value + 1) };
}
