"use client";

/**
 * The projects someone has, and the four things they can do to them.
 *
 * Everything here is a request the user made — there is no stream to subscribe to and nothing
 * arrives on its own — so the whole hook is "ask, then ask again once something changed".
 * After a create, a close or a delete it reloads the list rather than editing it in place: the
 * server is the one that knows whether a close actually put the project away, and a list
 * patched locally from an assumption is how a row ends up claiming to be idle while its
 * sandbox is still running.
 *
 * `fetch` comes in through an argument, exactly as it does in `useProjectFiles`, so every
 * branch — including a failed delete — is testable without a network.
 *
 * Responses are parsed rather than trusted. An empty list and a malformed body look identical
 * on screen otherwise, and the first is ordinary while the second means something is wrong.
 */

import {
  CreatedProjectSchema,
  ProjectListSchema,
  type ProjectSummaryPayload,
  ProjectSummarySchema,
} from "@nap/shared/projects-protocol";
import { useCallback, useEffect, useState } from "react";
import type { FetchJson } from "../files/use-project-files.ts";

export type ProjectsStatus = "loading" | "ready" | "error";

export type Projects = {
  projects: ProjectSummaryPayload[];
  status: ProjectsStatus;
  /** Set when the last action failed, in words meant for the person who tried it. */
  actionError: string | undefined;
  create: () => Promise<string | undefined>;
  close: (projectId: string) => Promise<void>;
  remove: (projectId: string) => Promise<void>;
};

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function useProjects(options: { baseUrl?: string; fetchJson?: FetchJson } = {}): Projects {
  const { baseUrl = DEFAULT_BASE_URL } = options;
  const fetchJson = options.fetchJson ?? ((url, init) => fetch(url, init));

  const [projects, setProjects] = useState<ProjectSummaryPayload[]>([]);
  const [status, setStatus] = useState<ProjectsStatus>("loading");
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  // `fetchJson` is deliberately not a dependency; see the note in `useProjectFiles`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const reload = useCallback(async () => {
    try {
      const response = await fetchJson(`${baseUrl}/projects`);
      if (!response.ok) throw new Error(`the server answered ${response.status}`);

      const parsed = ProjectListSchema.parse(await response.json());
      setProjects(parsed.projects);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [baseUrl]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const act = useCallback(
    async (url: string, init: RequestInit, whatFailed: string): Promise<Response | undefined> => {
      setActionError(undefined);
      try {
        const response = await fetchJson(url, init);
        if (!response.ok) {
          // The server's own sentence when it has one — "a turn is running in this project"
          // is the whole explanation, and replacing it with a status code helps nobody.
          setActionError(await reasonFrom(response, whatFailed));
          return undefined;
        }
        return response;
      } catch {
        setActionError(`${whatFailed} — could not reach the server.`);
        return undefined;
      }
    },
    [],
  );

  const create = useCallback(async (): Promise<string | undefined> => {
    const response = await act(
      `${baseUrl}/projects`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      "Could not create a project",
    );
    if (response === undefined) return undefined;

    try {
      const created = CreatedProjectSchema.parse(await response.json());
      await reload();
      return created.projectId;
    } catch {
      setActionError("Could not create a project — the server sent something unexpected.");
      return undefined;
    }
  }, [act, baseUrl, reload]);

  const close = useCallback(
    async (projectId: string): Promise<void> => {
      const done = await act(
        `${baseUrl}/projects/${projectId}/close`,
        { method: "POST" },
        "Could not put the project away",
      );
      if (done !== undefined) await reload();
    },
    [act, baseUrl, reload],
  );

  const remove = useCallback(
    async (projectId: string): Promise<void> => {
      const done = await act(
        `${baseUrl}/projects/${projectId}`,
        { method: "DELETE" },
        "Could not delete the project",
      );
      if (done !== undefined) await reload();
    },
    [act, baseUrl, reload],
  );

  return { projects, status, actionError, create, close, remove };
}

/** The server's explanation if it sent one, and a plain sentence if it did not. */
async function reasonFrom(response: Response, whatFailed: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    const error =
      typeof body === "object" && body !== null && "error" in body
        ? (body as { error: unknown }).error
        : undefined;
    if (typeof error === "string" && error !== "") return `${whatFailed} — ${error}.`;
  } catch {
    // A body that is not JSON tells us nothing; fall through to the status.
  }
  return `${whatFailed} — the server answered ${response.status}.`;
}

export type OpenProject = {
  project: ProjectSummaryPayload | undefined;
  status: "loading" | "ready" | "missing" | "error";
};

/**
 * One project, which is what the workspace needs to know what it is looking at.
 *
 * The session it opens in comes from here rather than from the URL: a project is the thing a
 * person has, and which conversation inside it they land in is a detail the server decides —
 * the newest one. Keeping the session id out of the address bar also means a link to a project
 * cannot go stale when its sessions change.
 *
 * `missing` is separate from `error` because they are different sentences: a project that was
 * deleted in another tab is gone for good, and a server that is down will come back.
 */
export function useProject(
  projectId: string,
  options: { baseUrl?: string; fetchJson?: FetchJson } = {},
): OpenProject {
  const { baseUrl = DEFAULT_BASE_URL } = options;
  const fetchJson = options.fetchJson ?? ((url, init) => fetch(url, init));

  const [project, setProject] = useState<ProjectSummaryPayload | undefined>(undefined);
  const [status, setStatus] = useState<OpenProject["status"]>("loading");

  // `fetchJson` is deliberately not a dependency; see the note in `useProjectFiles`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let abandoned = false;

    void (async () => {
      try {
        const response = await fetchJson(`${baseUrl}/projects/${projectId}`);
        if (abandoned) return;

        if (response.status === 404) {
          setStatus("missing");
          return;
        }
        if (!response.ok) throw new Error(`the server answered ${response.status}`);

        setProject(ProjectSummarySchema.parse(await response.json()));
        setStatus("ready");
      } catch {
        if (!abandoned) setStatus("error");
      }
    })();

    return () => {
      abandoned = true;
    };
  }, [projectId, baseUrl]);

  return { project, status };
}
