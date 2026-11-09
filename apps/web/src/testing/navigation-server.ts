/**
 * The session-navigation API, in memory, behind a `fetchJson`.
 *
 * It answers the requests `useSessionNavigation` makes the way the real routes do — revision
 * checks, the busy rule for parking, the same `applyNavigationChange` the store runs — so a test
 * can watch the hook's optimistic rows against a server that actually disagrees with it. A test
 * can hold a request open (`hold`) to look at the rows while it is in flight, or make the next
 * one fail (`refuseNext`), and every request is recorded in `requests` for assertions on what
 * was sent. The browser proof of dragging runs against it too, so it must not touch the DOM.
 */

import {
  applyNavigationChange,
  NavigationChangeSchema,
  SessionReorderSchema,
  type SessionSummary,
  sessionSection,
} from "@nap/shared/session-navigation";

export type RecordedRequest = { method: string; path: string; body: unknown };

export function navigationServer(initial: readonly SessionSummary[]) {
  let rows = initial.map((row) => structuredClone(row));
  const requests: RecordedRequest[] = [];
  let refusal: { status: number; error: string } | undefined;
  let gate: Promise<void> | undefined;

  const answer = (body: unknown, status = 200) => Response.json(body, { status });

  const handle = (method: string, path: string, body: unknown): Response => {
    if (method === "GET" && path === "/sessions") return answer({ sessions: rows, next: null });
    if (refusal) {
      const { status, error } = refusal;
      refusal = undefined;
      return answer({ error }, status);
    }
    if (method === "POST" && path === "/sessions/order") {
      const input = SessionReorderSchema.safeParse(body);
      if (!input.success) return answer({ error: "Invalid session order." }, 400);
      for (const requested of input.data.rows) {
        const row = rows.find((item) => item.projectId === requested.projectId);
        if (!row) return answer({ error: "A session is no longer available." }, 404);
        if (
          row.revision !== requested.revision ||
          sessionSection(row, Date.now()) !== input.data.section
        )
          return answer({ error: "These sessions changed. Try the move again." }, 409);
      }
      for (const [position, requested] of input.data.rows.entries())
        update(requested.projectId, (row) => ({
          ...row,
          navigation: { ...row.navigation, position },
          revision: row.revision + 1,
        }));
      return answer({ saved: true });
    }
    const match = /^\/projects\/([^/]+)(\/navigation|\/close)?$/.exec(path);
    const row = match && rows.find((item) => item.projectId === match[1]);
    if (!match || !row) return answer({ error: "No such session." }, 404);
    if (match[2] === "/navigation" && method === "PATCH") {
      const input = NavigationChangeSchema.safeParse(body);
      if (!input.success) return answer({ error: "Invalid session action." }, 400);
      if (input.data.revision !== row.revision)
        return answer({ error: "This session changed in another tab. Try again." }, 409);
      const change = input.data.change;
      const parks =
        (change.kind === "done" || change.kind === "archive" ? change.value : false) ||
        (change.kind === "snooze" && change.until !== null);
      if (parks && (row.activity === "working" || row.activity === "queued"))
        return answer(
          { error: "Wait for active work to finish before parking this session." },
          409,
        );
      const navigation = applyNavigationChange(row.navigation, change, new Date().toISOString());
      const revision = row.revision + 1;
      update(row.projectId, (current) => ({ ...current, navigation, revision }));
      return answer({ navigation, revision });
    }
    if (match[2] === "/close" && method === "POST") {
      update(row.projectId, (current) => ({ ...current, sandboxId: null }));
      return answer({ closed: true });
    }
    if (match[2] === undefined && method === "PATCH") {
      const name = (body as { name?: unknown } | null)?.name;
      if (typeof name !== "string" || !name.trim())
        return answer({ error: "Name is required." }, 400);
      update(row.projectId, (current) => ({ ...current, name }));
      return answer({ ...row, name });
    }
    if (match[2] === undefined && method === "DELETE") {
      rows = rows.filter((item) => item.projectId !== row.projectId);
      return answer({ deleted: true });
    }
    return answer({ error: "Not found." }, 404);
  };

  const update = (projectId: string, next: (row: SessionSummary) => SessionSummary) => {
    rows = rows.map((row) => (row.projectId === projectId ? next(row) : row));
  };

  const fetchJson = async (url: string, init?: RequestInit): Promise<Response> => {
    const { pathname } = new URL(url, "http://navigation.test");
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (method !== "GET") requests.push({ method, path: pathname, body });
    // Held writes wait; reads never do, so a poll can arrive while a write is in flight.
    if (method !== "GET" && gate) await gate;
    return handle(method, pathname, body);
  };

  return {
    fetchJson,
    requests,
    /** The server's current rows, for asserting what it holds rather than what was drawn. */
    rows: () => rows,
    /** Change a row server-side, as another tab or a running turn would. */
    edit: update,
    /** The next write is refused with this status and message. */
    refuseNext(status: number, error: string) {
      refusal = { status, error };
    },
    /** Hold every write until the returned function is called. */
    hold(): () => void {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = undefined;
          resolve();
        };
      });
      return release;
    },
  };
}
