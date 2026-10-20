"use client";

import {
  type NavigationChange,
  NavigationSavedSchema,
  type SessionList,
  SessionListSchema,
  type SessionNavigation,
  type SessionReorder,
  type SessionSummary,
} from "@nap/shared/session-navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { GITHUB_API_URL, githubRequest } from "../github/request.ts";

type UndoAction = {
  projectId: string;
  revision: number;
  navigation: SessionNavigation;
  label: string;
};
const labels = {
  pin: "Pin updated",
  done: "Done updated",
  archive: "Archive updated",
  snooze: "Snooze updated",
  read: "Read state updated",
  restore: "Previous state restored",
};

export function useSessionNavigation({
  fetchJson = credentialedFetch,
  baseUrl = GITHUB_API_URL,
}: {
  fetchJson?: FetchJson;
  baseUrl?: string;
} = {}) {
  const [projects, setProjects] = useState<SessionSummary[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [actionError, setError] = useState<string>();
  const [undoAction, setUndo] = useState<UndoAction>();
  const [busyProjectId, setBusy] = useState<string>();
  const generation = useRef(0);
  const acting = useRef(false);
  const rows = useRef(projects);
  rows.current = projects;
  const reload = useCallback(async () => {
    const version = ++generation.current;
    const nextRows: SessionSummary[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const result: { ok: true; value: SessionList } | { ok: false; error: string } =
        await githubRequest(
          fetchJson,
          `${baseUrl}/sessions${cursor ? `?after=${cursor}` : ""}`,
          SessionListSchema,
        );
      if (generation.current !== version) return;
      if (!result.ok) {
        setStatus("error");
        setError(result.error);
        return;
      }
      nextRows.push(...result.value.sessions);
      cursor = result.value.next;
      if (cursor && seen.has(cursor)) {
        setStatus("error");
        setError("The session list could not finish loading. Try again.");
        return;
      }
      if (cursor) seen.add(cursor);
    } while (cursor);
    setProjects(nextRows);
    setStatus("ready");
  }, [fetchJson, baseUrl]);
  useEffect(() => {
    void reload();
    const refresh = () => {
      if (!document.hidden && !acting.current) void reload();
    };
    const timer = setInterval(refresh, 10000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const channel =
      typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("nap-sessions");
    if (channel) channel.onmessage = refresh;
    return () => {
      generation.current++;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      channel?.close();
    };
  }, [reload]);
  const notify = () => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("nap-sessions");
    channel.postMessage("changed");
    channel.close();
  };
  const save = async (projectId: string, input: NavigationChange) => {
    generation.current++;
    const result = await githubRequest(
      fetchJson,
      `${baseUrl}/projects/${projectId}/navigation`,
      NavigationSavedSchema,
      {
        method: "PATCH",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    if (!result.ok) {
      if (input.change.kind !== "read") setError(result.error);
    } else {
      setProjects((current) =>
        current.map((row) => (row.projectId === projectId ? { ...row, ...result.value } : row)),
      );
      notify();
    }
    await reload();
    return result;
  };
  const change = async (projectId: string, change: NavigationChange["change"]) => {
    const row = rows.current.find((item) => item.projectId === projectId);
    if (!row || acting.current) return;
    acting.current = true;
    setBusy(projectId);
    setError(undefined);
    try {
      const previous = row.navigation;
      const result = await save(projectId, { revision: row.revision, change });
      if (result.ok && ["pin", "done", "archive", "snooze"].includes(change.kind))
        setUndo({
          projectId,
          revision: result.value.revision,
          navigation: previous,
          label: labels[change.kind],
        });
    } finally {
      acting.current = false;
      setBusy(undefined);
    }
  };
  const undo = async () => {
    if (!undoAction || acting.current) return;
    acting.current = true;
    setBusy(undoAction.projectId);
    setError(undefined);
    try {
      const result = await save(undoAction.projectId, {
        revision: undoAction.revision,
        change: { kind: "restore", navigation: undoAction.navigation },
      });
      if (result.ok) setUndo(undefined);
    } finally {
      acting.current = false;
      setBusy(undefined);
    }
  };
  const reorder = async (input: SessionReorder) => {
    if (acting.current) return;
    acting.current = true;
    setBusy(input.rows[0]?.projectId);
    setError(undefined);
    generation.current++;
    try {
      const result = await githubRequest(
        fetchJson,
        `${baseUrl}/sessions/order`,
        z.object({ saved: z.literal(true) }),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!result.ok) setError(result.error);
      else notify();
      await reload();
    } finally {
      acting.current = false;
      setBusy(undefined);
    }
  };
  const lifecycle = async (
    id: string,
    method: string,
    suffix: string,
    body?: unknown,
  ): Promise<boolean> => {
    if (acting.current) return false;
    acting.current = true;
    setBusy(id);
    setError(undefined);
    generation.current++;
    try {
      const result = await githubRequest(
        fetchJson,
        `${baseUrl}/projects/${id}${suffix}`,
        z.object({}).passthrough(),
        {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      if (!result.ok) setError(result.error);
      else notify();
      await reload();
      return result.ok;
    } finally {
      acting.current = false;
      setBusy(undefined);
    }
  };
  return {
    projects,
    status,
    actionError,
    busyProjectId,
    undoAction,
    change,
    undo,
    reorder,
    reload,
    dismissUndo: () => setUndo(undefined),
    rename: (id: string, name: string) => lifecycle(id, "PATCH", "", { name }),
    remove: (id: string) => lifecycle(id, "DELETE", ""),
    close: (id: string) => lifecycle(id, "POST", "/close"),
  };
}
