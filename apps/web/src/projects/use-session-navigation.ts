"use client";

import {
  type NavigationChange,
  NavigationSavedSchema,
  type SessionList,
  SessionListSchema,
  type SessionNavigation,
  SessionSearchSchema,
  type SessionSection,
  type SessionSummary,
} from "@nap/shared/session-navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { GITHUB_API_URL, githubRequest } from "../github/request.ts";
import { forgetLog } from "../hooks/remembered-logs.ts";
import { forgetKnownProject, knownProjectsEpoch, rememberProjects } from "./known-projects.ts";
import { type PendingOp, withPending } from "./navigation-overlay.ts";
import { type SessionListNotices, sessionListNotices } from "./session-list-notices.ts";
import type { SearchSessions } from "./use-session-search.ts";

/** One thing to do to the session list. A move between shelves is several, applied together. */
export type NavigationStep =
  | { kind: "change"; projectId: string; change: NavigationChange["change"] }
  | { kind: "reorder"; section: SessionSection; projectIds: readonly string[] };

export type ApplyOptions = {
  /** What the undo notice says, and whether there is one. Omitted, nothing can be undone. */
  label?: string | undefined;
  /** Say nothing if the server refuses — for reads nobody asked for. */
  quiet?: boolean | undefined;
};

type UndoAction = {
  label: string;
  entries: readonly { projectId: string; navigation: SessionNavigation; revision: number }[];
};

/** One action waiting for the server, and the group it belongs to. */
type Entry = { op: PendingOp; group: Group };
type Group = { failed: boolean; quiet: boolean };

/**
 * The session list, and every way of changing it.
 *
 * Every action is drawn at once and sent after: the rows this returns are the server's last
 * answer with every action still on its way folded over it (`navigation-overlay.ts`). Writes go
 * one at a time, in the order they were made, and each reads the revision the server last
 * confirmed when it is *sent* — so two quick changes to one row carry consecutive revisions
 * instead of the second colliding with the first. A refusal takes its action, and the rest of
 * that action's group, out of the fold; the row goes back to where the server has it, and the
 * error names it.
 */
export function useSessionNavigation({
  fetchJson = credentialedFetch,
  baseUrl = GITHUB_API_URL,
  notices,
}: {
  fetchJson?: FetchJson;
  baseUrl?: string;
  /** What says the list changed. The tab's own socket unless a test hands in another. */
  notices?: SessionListNotices;
} = {}) {
  const [projects, setProjects] = useState<SessionSummary[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [actionError, setError] = useState<string>();
  const [undoAction, setUndo] = useState<UndoAction>();
  const confirmed = useRef<SessionSummary[]>([]);
  const pending = useRef<Entry[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  /** Moves on every reload and every settled write, so a reply from before either is dropped. */
  const generation = useRef(0);
  /** When the list was last asked for, which the slow backstop below is measured from. */
  const readAt = useRef(0);
  /** Whether the last read failed, which is retried on the short timer however live the tab is. */
  const readFailed = useRef(false);

  const publish = useCallback(() => {
    setProjects(
      withPending(
        confirmed.current,
        pending.current.map((entry) => entry.op),
      ),
    );
  }, []);

  const reload = useCallback(async () => {
    const version = ++generation.current;
    readAt.current = Date.now();
    const since = knownProjectsEpoch();
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
        readFailed.current = true;
        setStatus("error");
        setError(result.error);
        return;
      }
      nextRows.push(...result.value.sessions);
      cursor = result.value.next;
      if (cursor && seen.has(cursor)) {
        readFailed.current = true;
        setStatus("error");
        setError("The session list could not finish loading. Try again.");
        return;
      }
      if (cursor) seen.add(cursor);
    } while (cursor);
    readFailed.current = false;
    confirmed.current = nextRows;
    // Every row is a project record, so opening one can draw its title and connect to its session
    // without waiting for the project's own read. See `known-projects.ts`.
    rememberProjects(nextRows, since);
    publish();
    setStatus("ready");
  }, [fetchJson, baseUrl, publish]);

  /** One search of the caller's sessions; `signal` lets the next keystroke drop this one. */
  const search: SearchSessions = useCallback(
    (query, signal) =>
      githubRequest(
        fetchJson,
        `${baseUrl}/sessions/search?q=${encodeURIComponent(query)}`,
        SessionSearchSchema,
        { signal },
      ),
    [fetchJson, baseUrl],
  );

  // The list is read when the server says it changed (`session-list-notices.ts`), and on a timer
  // only while that cannot be heard. A hidden tab reads nothing — it reads when it is looked at —
  // and while the server is writing nothing, neither is anybody's tab.
  useEffect(() => {
    const source = notices ?? sessionListNotices();
    // A read on its way already answers whatever changed before it started; a change after that
    // is read once more when it lands. Starting a fresh read on every notice instead would discard
    // the one in flight, and a steady stream of notices could then discard every read before any
    // arrived. "On its way" ends when anything newer has been read since (the generation moved),
    // or after `SESSION_LIST_READ_STALL_MS`: a request that never answers must not hold every
    // later one behind it.
    let disposed = false;
    let readVersion = -1;
    let readStartedAt = 0;
    let again = false;
    const reading = () =>
      readVersion === generation.current && Date.now() - readStartedAt < SESSION_LIST_READ_STALL_MS;
    const read = () => {
      // `reload` takes the next generation as its first step.
      const version = generation.current + 1;
      readVersion = version;
      readStartedAt = Date.now();
      void reload().finally(() => {
        if (readVersion !== version) return;
        readVersion = -1;
        if (again && !disposed) {
          again = false;
          refresh();
        }
      });
    };
    const refresh = () => {
      if (document.hidden || pending.current.length > 0) return;
      if (reading()) again = true;
      else read();
    };
    read();
    const timer = setInterval(() => {
      if (
        !source.live() ||
        readFailed.current ||
        Date.now() - readAt.current >= SESSION_LIST_BACKSTOP_MS
      )
        refresh();
    }, SESSION_LIST_POLL_MS);
    // `down` needs nothing: the timer above takes over until the next `live`.
    const unsubscribe = source.subscribe((notice) => {
      if (notice !== "down") refresh();
    });
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const channel =
      typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("nap-sessions");
    if (channel) channel.onmessage = refresh;
    return () => {
      disposed = true;
      generation.current++;
      clearInterval(timer);
      unsubscribe();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      channel?.close();
    };
  }, [reload, notices]);

  /**
   * Titles this tab asked for and is still waiting on. Drawn as `titling` straight away, before
   * the server's own flag could arrive on the next read.
   */
  const [titlingIds, setTitlingIds] = useState<ReadonlySet<string>>(new Set());
  const undim = useCallback((projectId: string) => {
    setTitlingIds((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  }, []);
  const regenerateTitle = useCallback(
    async (projectId: string) => {
      setTitlingIds((current) => new Set(current).add(projectId));
      const result = await githubRequest(
        fetchJson,
        `${baseUrl}/projects/${projectId}/title`,
        z.object({ name: z.string() }),
        { method: "POST" },
      );
      if (result.ok) {
        // The name the server wrote, drawn now: a read that fails below must not bring back the
        // old one.
        confirmed.current = confirmed.current.map((row) =>
          row.projectId === projectId ? { ...row, name: result.value.name, titling: false } : row,
        );
        publish();
      } else if (result.code !== "renamed") {
        // A rename the person made meanwhile won, as they meant it to; that is not an error.
        setError(result.error);
      }
      // Either way the list is read again: the name, or the flag that a title is no longer due.
      // The row stays dimmed until that read is over, so it never shows the old name undimmed.
      try {
        await reload();
      } finally {
        undim(projectId);
      }
      if (result.ok) announceSessionsChanged();
    },
    [fetchJson, baseUrl, reload, publish, undim],
  );
  // A title the server is writing on its own, after a first prompt, lands in seconds; read again
  // every few until it has. Its landing is announced, but a claim that expires unanswered is not —
  // nothing writes when it does — and the flag expires with that claim, so this cannot outlast it.
  const serverTitling = projects.some((row) => row.titling);
  useEffect(() => {
    if (!serverTitling) return;
    const timer = setInterval(() => void reload(), TITLING_RECHECK_MS);
    return () => clearInterval(timer);
  }, [serverTitling, reload]);
  const drawn = useMemo(
    () =>
      titlingIds.size === 0
        ? projects
        : projects.map((row) => (titlingIds.has(row.projectId) ? { ...row, titling: true } : row)),
    [projects, titlingIds],
  );

  /** Sends one write and answers with the server's refusal, or nothing when it was saved. */
  const send = useCallback(
    async (op: PendingOp, revision?: number): Promise<string | undefined> => {
      const json = { "content-type": "application/json" };
      const current = (id: string) => confirmed.current.find((item) => item.projectId === id);
      if (op.kind === "reorder") {
        const rows = op.projectIds.map((projectId) => current(projectId));
        if (rows.some((item) => item === undefined)) return "A session is no longer available.";
        const result = await githubRequest(
          fetchJson,
          `${baseUrl}/sessions/order`,
          z.object({ saved: z.literal(true) }),
          {
            method: "POST",
            headers: json,
            body: JSON.stringify({
              section: op.section,
              rows: rows.map((item) => ({
                projectId: item?.projectId,
                revision: item?.revision,
              })),
            }),
          },
        );
        if (!result.ok) return result.error;
        // The server moves each revision by one; knowing that saves waiting for a reload.
        const revisions = new Map(rows.map((item) => [item?.projectId, (item?.revision ?? 0) + 1]));
        confirmed.current = withPending(confirmed.current, [op]).map((item) =>
          revisions.has(item.projectId)
            ? { ...item, revision: revisions.get(item.projectId) ?? item.revision }
            : item,
        );
        return undefined;
      }
      const row = current(op.projectId);
      if (!row) return "This session is no longer available.";
      if (op.kind === "change") {
        const result = await githubRequest(
          fetchJson,
          `${baseUrl}/projects/${op.projectId}/navigation`,
          NavigationSavedSchema,
          {
            method: "PATCH",
            keepalive: true,
            headers: json,
            body: JSON.stringify({ revision: revision ?? row.revision, change: op.change }),
          },
        );
        if (!result.ok) return result.error;
        confirmed.current = confirmed.current.map((item) =>
          item.projectId === op.projectId ? { ...item, ...result.value } : item,
        );
        return undefined;
      }
      const [method, suffix, body] =
        op.kind === "rename"
          ? ["PATCH", "", { name: op.name }]
          : op.kind === "remove"
            ? ["DELETE", "", undefined]
            : ["POST", "/close", undefined];
      const result = await githubRequest(
        fetchJson,
        `${baseUrl}/projects/${op.projectId}${suffix}`,
        z.object({}).passthrough(),
        {
          method,
          headers: json,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      if (!result.ok) return result.error;
      // A deleted project's kept log must never be drawn again, whichever list deleted it.
      if (op.kind === "remove") {
        forgetLog(op.projectId);
        forgetKnownProject(op.projectId);
      }
      confirmed.current = withPending(confirmed.current, [op]);
      return undefined;
    },
    [fetchJson, baseUrl],
  );

  /**
   * Draws `ops` now and queues them. Resolves true once every one was saved, or false at the
   * first refusal, which also drops the rest of the group unsent.
   */
  const enqueue = useCallback(
    (
      ops: readonly PendingOp[],
      options: ApplyOptions & { revisions?: ReadonlyMap<string, number> } = {},
    ): Promise<boolean> => {
      const quiet = options.quiet ?? false;
      if (!quiet) setError(undefined);
      const group: Group = { failed: false, quiet };
      const entries = ops.map((op) => ({ op, group }));
      pending.current = [...pending.current, ...entries];
      publish();
      let before: { projectId: string; navigation: SessionNavigation }[] = [];
      const started = queue.current.then(() => {
        if (!options.label) return;
        const ids = new Set(ops.flatMap((op) => (op.kind === "change" ? [op.projectId] : [])));
        before = confirmed.current
          .filter((row) => ids.has(row.projectId))
          .map(({ projectId, navigation }) => ({ projectId, navigation }));
      });
      const done = entries.reduce<Promise<void>>(
        (previous, entry) =>
          previous.then(async () => {
            if (!group.failed) {
              const refusal = await send(
                entry.op,
                entry.op.kind === "change" ? options.revisions?.get(entry.op.projectId) : undefined,
              );
              if (refusal !== undefined) {
                group.failed = true;
                const { op } = entry;
                const name =
                  op.kind === "reorder"
                    ? undefined
                    : confirmed.current.find((item) => item.projectId === op.projectId)?.name;
                if (!quiet) setError(name ? `“${name}”: ${refusal}` : refusal);
              }
            }
            generation.current++;
            pending.current = pending.current.filter((item) =>
              group.failed ? item.group !== group : item !== entry,
            );
            publish();
          }),
        started,
      );
      queue.current = done.then(() => {
        if (!group.failed && options.label && before.length > 0) {
          setUndo({
            label: options.label,
            entries: before.flatMap((entry) => {
              const row = confirmed.current.find((item) => item.projectId === entry.projectId);
              return row ? [{ ...entry, revision: row.revision }] : [];
            }),
          });
        }
        if (pending.current.length > 0) return;
        announceSessionsChanged();
        void reload();
      });
      return done.then(() => !group.failed);
    },
    [publish, reload, send],
  );

  const apply = useCallback(
    async (steps: readonly NavigationStep[], options: ApplyOptions = {}): Promise<boolean> => {
      const at = new Date().toISOString();
      const ops = steps.map((step): PendingOp => (step.kind === "change" ? { ...step, at } : step));
      return enqueue(ops, options);
    },
    [enqueue],
  );

  const change = useCallback(
    (projectId: string, next: NavigationChange["change"], options: ApplyOptions = {}) =>
      apply([{ kind: "change", projectId, change: next }], {
        label: undoLabel(next),
        ...options,
      }),
    [apply],
  );

  const undo = useCallback(async () => {
    if (!undoAction) return;
    setUndo(undefined);
    await enqueue(
      undoAction.entries.map(({ projectId, navigation }) => ({
        kind: "change",
        projectId,
        change: { kind: "restore", navigation },
        at: new Date().toISOString(),
      })),
      {
        revisions: new Map(
          undoAction.entries.map(({ projectId, revision }) => [projectId, revision]),
        ),
      },
    );
  }, [enqueue, undoAction]);

  return {
    projects: drawn,
    status,
    actionError,
    undoAction,
    apply,
    change,
    undo,
    reload,
    dismissUndo: () => setUndo(undefined),
    rename: (projectId: string, name: string) => {
      // The person's name wins over a title still being written, so the row stops saying one is.
      undim(projectId);
      return enqueue([{ kind: "rename", projectId, name }]);
    },
    remove: (projectId: string) => enqueue([{ kind: "remove", projectId }]),
    close: (projectId: string) => enqueue([{ kind: "close", projectId }]),
    search,
    regenerateTitle,
  };
}

/** How soon the list is read again while a model is writing a session's title. */
export const TITLING_RECHECK_MS = 2000;

/**
 * How long a read may be on its way before a notice starts another beside it rather than waiting:
 * a request that never answers must not hold every later read behind it.
 */
export const SESSION_LIST_READ_STALL_MS = 30_000;

/** How often the list is read while the server's notices cannot be heard. */
export const SESSION_LIST_POLL_MS = 10_000;

/**
 * How often it is read even while they can. A notice is a wake-up rather than a delivery, and one
 * can be lost — a listener reconnecting, a process dying between its commit and its announcement —
 * so a list that hears nothing for this long reads anyway. Focusing the tab reads too.
 */
export const SESSION_LIST_BACKSTOP_MS = 5 * 60_000;

/**
 * Tells every other list of this user's sessions that it changed, so it reads again rather than
 * wait for a poll — other tabs, and other hooks in this one, since a channel hears every instance
 * but the one that sent.
 */
export function announceSessionsChanged() {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel("nap-sessions");
  channel.postMessage("changed");
  channel.close();
}

/** What the undo notice says after one change, or nothing for a change not worth undoing. */
function undoLabel(change: NavigationChange["change"]): string | undefined {
  switch (change.kind) {
    case "pin":
      return change.pinned ? "Pinned" : "Unpinned";
    case "done":
      return change.value ? undefined : "Un-settled";
    case "archive":
      return change.value ? "Archived" : "Restored";
    case "snooze":
      return change.until === null ? "Woken" : "Snoozed";
    default:
      return undefined;
  }
}
