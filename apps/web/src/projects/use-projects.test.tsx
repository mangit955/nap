import type { ProjectSummaryPayload } from "@nap/shared/projects-protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useProject, useProjects } from "./use-projects.ts";

/**
 * A `.test.tsx` even with no JSX in it: a hook needs React, and a `.test.ts` under `apps/web`
 * is collected by the `unit` project, which has no DOM.
 */

const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const SESSION = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";

function summary(overrides: Partial<ProjectSummaryPayload> = {}): ProjectSummaryPayload {
  return {
    projectId: PROJECT,
    name: "Todo app",
    status: "ready",
    sandboxId: "sbx_live",
    updatedAt: "2026-08-09T11:00:00.000Z",
    sessionIds: [SESSION],
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Records every request, and answers each URL however the test says. */
function server(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetchJson = async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    calls.push(key);
    const route = routes[key];
    return route === undefined ? json({ error: "no such route" }, 404) : route();
  };
  return { calls, fetchJson };
}

const BASE = "http://api.test";

function listOnly(projects: ProjectSummaryPayload[] = [summary()]) {
  return server({ "GET /projects": () => json({ projects }) });
}

describe("loading the list", () => {
  it("asks once and reports what came back", async () => {
    const { fetchJson } = listOnly();

    const { result } = renderHook(() => useProjects({ baseUrl: BASE, fetchJson }));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.projects).toHaveLength(1);
  });

  it("reports a failure rather than showing an empty list", async () => {
    // An empty list means "you have no projects", which is a different sentence from "the
    // server is down" — and showing the first when the second is true invites a second click
    // on New project.
    const { fetchJson } = server({ "GET /projects": () => json({ error: "boom" }, 500) });

    const { result } = renderHook(() => useProjects({ baseUrl: BASE, fetchJson }));

    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("treats a malformed body as a failure", async () => {
    const { fetchJson } = server({ "GET /projects": () => json({ projects: [{ id: 1 }] }) });

    const { result } = renderHook(() => useProjects({ baseUrl: BASE, fetchJson }));

    await waitFor(() => expect(result.current.status).toBe("error"));
  });
});

describe("creating a project", () => {
  it("hands back the id to open, and reloads the list", async () => {
    const { calls, fetchJson } = server({
      "GET /projects": () => json({ projects: [summary()] }),
      "POST /projects": () => json({ projectId: PROJECT, sessionId: SESSION }, 201),
    });
    const { result } = renderHook(() => useProjects({ baseUrl: BASE, fetchJson }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let created: string | undefined;
    await act(async () => {
      created = await result.current.create();
    });

    expect(created).toBe(PROJECT);
    // Reloaded rather than patched: the server decides what the new list looks like.
    expect(calls.filter((call) => call === "GET /projects")).toHaveLength(2);
  });

  it("reports a failure and creates nothing", async () => {
    const { fetchJson } = server({
      "GET /projects": () => json({ projects: [] }),
      "POST /projects": () => json({ error: "no database" }, 500),
    });
    const { result } = renderHook(() => useProjects({ baseUrl: BASE, fetchJson }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let created: string | undefined = "not undefined";
    await act(async () => {
      created = await result.current.create();
    });

    expect(created).toBeUndefined();
    expect(result.current.actionError).toMatch(/no database/);
  });
});

describe("closing and deleting", () => {
  it("puts a project away and reloads", async () => {
    const { calls, fetchJson } = server({
      "GET /projects": () => json({ projects: [summary()] }),
      [`POST /projects/${PROJECT}/close`]: () => json({ closed: true }),
    });
    const { result } = renderHook(() => useProjects({ baseUrl: BASE, fetchJson }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.close(PROJECT);
    });

    expect(calls).toContain(`POST /projects/${PROJECT}/close`);
    expect(calls.filter((call) => call === "GET /projects")).toHaveLength(2);
  });

  it("deletes a project and reloads", async () => {
    const { calls, fetchJson } = server({
      "GET /projects": () => json({ projects: [summary()] }),
      [`DELETE /projects/${PROJECT}`]: () => json({ deleted: true, objectsDeleted: 1 }),
    });
    const { result } = renderHook(() => useProjects({ baseUrl: BASE, fetchJson }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.remove(PROJECT);
    });

    expect(calls).toContain(`DELETE /projects/${PROJECT}`);
    expect(calls.filter((call) => call === "GET /projects")).toHaveLength(2);
  });

  it("carries the server's own explanation of a refusal", async () => {
    // "a turn is running in this project" is the entire explanation. Replacing it with a
    // status code tells the user nothing they can act on.
    const { fetchJson } = server({
      "GET /projects": () => json({ projects: [summary()] }),
      [`DELETE /projects/${PROJECT}`]: () =>
        json({ error: "a turn is running in this project" }, 409),
    });
    const { result } = renderHook(() => useProjects({ baseUrl: BASE, fetchJson }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.remove(PROJECT);
    });

    expect(result.current.actionError).toMatch(/a turn is running/);
  });

  it("does not reload after a refused action", async () => {
    // Nothing changed, and a reload would replace the message the user is reading with a
    // fresh render of the same list.
    const { calls, fetchJson } = server({
      "GET /projects": () => json({ projects: [summary()] }),
      [`DELETE /projects/${PROJECT}`]: () => json({ error: "busy" }, 409),
    });
    const { result } = renderHook(() => useProjects({ baseUrl: BASE, fetchJson }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.remove(PROJECT);
    });

    expect(calls.filter((call) => call === "GET /projects")).toHaveLength(1);
  });

  it("clears the previous error when a new action starts", async () => {
    const { fetchJson } = server({
      "GET /projects": () => json({ projects: [summary()] }),
      [`DELETE /projects/${PROJECT}`]: () => json({ error: "busy" }, 409),
      [`POST /projects/${PROJECT}/close`]: () => json({ closed: true }),
    });
    const { result } = renderHook(() => useProjects({ baseUrl: BASE, fetchJson }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.remove(PROJECT);
    });
    expect(result.current.actionError).toBeDefined();

    await act(async () => {
      await result.current.close(PROJECT);
    });

    expect(result.current.actionError).toBeUndefined();
  });
});

describe("opening one project", () => {
  it("reports the project and the session to talk in", async () => {
    const { fetchJson } = server({ [`GET /projects/${PROJECT}`]: () => json(summary()) });

    const { result } = renderHook(() => useProject(PROJECT, { baseUrl: BASE, fetchJson }));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.project?.sessionIds[0]).toBe(SESSION);
  });

  it("says a deleted project is gone rather than broken", async () => {
    // Different sentences: one was deleted in another tab and is never coming back, the other
    // is a server that will.
    const { fetchJson } = server({
      [`GET /projects/${PROJECT}`]: () => json({ error: "no such project" }, 404),
    });

    const { result } = renderHook(() => useProject(PROJECT, { baseUrl: BASE, fetchJson }));

    await waitFor(() => expect(result.current.status).toBe("missing"));
  });

  it("reports a server failure as an error", async () => {
    const { fetchJson } = server({
      [`GET /projects/${PROJECT}`]: () => json({ error: "boom" }, 500),
    });

    const { result } = renderHook(() => useProject(PROJECT, { baseUrl: BASE, fetchJson }));

    await waitFor(() => expect(result.current.status).toBe("error"));
  });
});
