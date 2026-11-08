"use client";

import {
  type NavigationChange,
  NavigationSavedSchema,
  type SessionList,
  SessionListSchema,
  type SessionNavigation,
  type SessionSection,
  type SessionSummary,
} from "@nap/shared/session-navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { GITHUB_API_URL, githubRequest } from "../github/request.ts";
import { type PendingOp, withPending } from "./navigation-overlay.ts";

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
}: {
  fetchJson?: FetchJson;
  baseUrl?: string;
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
    confirmed.current = nextRows;
    publish();
    setStatus("ready");
  }, [fetchJson, baseUrl, publish]);

  useEffect(() => {
    void reload();
    const refresh = () => {
      if (!document.hidden && pending.current.length === 0) void reload();
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
        notify();
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
    projects,
    status,
    actionError,
    undoAction,
    apply,
    change,
    undo,
    reload,
    dismissUndo: () => setUndo(undefined),
    rename: (projectId: string, name: string) => enqueue([{ kind: "rename", projectId, name }]),
    remove: (projectId: string) => enqueue([{ kind: "remove", projectId }]),
    close: (projectId: string) => enqueue([{ kind: "close", projectId }]),
  };
}

/** Tells this user's other tabs the list changed, so they reload rather than wait for a poll. */
function notify() {
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
      return change.value ? "Settled" : "Un-settled";
    case "archive":
      return change.value ? "Archived" : "Restored";
    case "snooze":
      return change.until === null ? "Woken" : "Snoozed";
    default:
      return undefined;
  }
}
