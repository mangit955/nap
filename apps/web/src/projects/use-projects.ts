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
  projectState,
} from "@nap/shared/projects-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
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
  rename: (projectId: string, name: string) => Promise<void>;
};

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/**
 * How long a restore may go unannounced before the panes stop claiming it is under way.
 *
 * Generous: a restore unbundles a project and starts a dev server, which is tens of seconds on
 * a cold sandbox. This is not a deadline for the server — nothing is cancelled when it passes
 * — only for how long the client is willing to say something is happening with no evidence.
 */
const RESTORE_CEILING_MS = 3 * 60 * 1000;

export function useProjects(options: { baseUrl?: string; fetchJson?: FetchJson } = {}): Projects {
  const { baseUrl = DEFAULT_BASE_URL } = options;
  const fetchJson = options.fetchJson ?? credentialedFetch;

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

  const rename = useCallback(
    async (projectId: string, name: string): Promise<void> => {
      const done = await act(
        `${baseUrl}/projects/${projectId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        },
        "Could not rename the project",
      );
      // Reloaded rather than patched in place, like every other action here: the server decides
      // what the name ended up as — it trims, and it may refuse — and a list edited from an
      // assumption is how a card ends up showing a name that was never stored.
      if (done !== undefined) await reload();
    },
    [act, baseUrl, reload],
  );

  return { projects, status, actionError, create, close, remove, rename };
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
  /**
   * When the server last confirmed this project had no sandbox serving it — or `undefined` if
   * it has one, has never had one, or has been resumed from this page since.
   *
   * **An instant rather than a boolean, and that is the whole point.** The record is read once,
   * when the workspace opens, and a turn started a second later creates a sandbox that
   * announces itself on the socket. A boolean cannot say which of the two is newer, so the
   * panes went on claiming a running project was put away. Both this and an event's `createdAt`
   * come from the server's clock, so they compare without any browser skew.
   *
   * A project that has never had a sandbox is not put away — it was never put anywhere — so it
   * reports nothing here and the panes invite a first prompt instead of offering to restore.
   */
  putAwayAt: string | undefined;
  /** Asks the server to start it back up. What the user then sees arrives as events. */
  resume: () => Promise<void>;
  /**
   * True from the request until the restore announces itself on the session's stream.
   *
   * Ending that wait needs a fact this hook cannot see — it holds a project record, not an
   * event log — so the newest `preview.ready` arrives as `previewSeq` from whoever does hold
   * the subscription. See the note on that option.
   */
  resuming: boolean;
  /** Set when the last resume was refused, in the server's own words. */
  resumeError: string | undefined;
  /**
   * Renames the project. Resolves to the name that was actually stored, or `undefined` if the
   * server refused — the caller puts the old one back rather than showing one nobody saved.
   */
  rename: (name: string) => Promise<string | undefined>;
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
  options: {
    baseUrl?: string;
    fetchJson?: FetchJson;
    /**
     * The `seq` of the newest `preview.ready` anybody watching this project's stream has seen.
     *
     * **This is what ends a restore**, and it is a sequence number rather than a boolean for
     * the same reason `putAwayAt` is an instant: the log still holds the announcement from
     * before the project was closed, so "there is a ready preview" is true the whole time and
     * would end the wait immediately — pointing an iframe at a sandbox that no longer exists.
     * Only an announcement newer than the one standing when the restore was asked for means
     * *this* restore came up.
     */
    previewSeq?: number | undefined;
  } = {},
): OpenProject {
  const { baseUrl = DEFAULT_BASE_URL, previewSeq } = options;
  const fetchJson = options.fetchJson ?? credentialedFetch;

  const [project, setProject] = useState<ProjectSummaryPayload | undefined>(undefined);
  const [status, setStatus] = useState<OpenProject["status"]>("loading");
  /** True between the click and the server's answer, before there is anything to wait for. */
  const [requesting, setRequesting] = useState(false);
  /**
   * The announcement that was standing when the restore was asked for, or `undefined` when no
   * restore is outstanding. Anything newer than this is the sandbox that was just made.
   */
  const [awaitingSince, setAwaitingSince] = useState<number | undefined>(undefined);
  const [resumeError, setResumeError] = useState<string | undefined>(undefined);
  /** Set once this pane has asked for the project, after which the record is out of date. */
  const [started, setStarted] = useState(false);

  // Read inside `resume` without making it a dependency: a callback rebuilt on every event
  // would change identity on every frame of a running turn, for a value it only reads once.
  const seqNow = useRef(previewSeq);
  seqNow.current = previewSeq;

  const announced = previewSeq ?? -1;
  const waiting = awaitingSince !== undefined && announced <= awaitingSince;
  const resuming = requesting || waiting;

  /**
   * A restore that never announces itself must not spin forever.
   *
   * It can happen: a resume that fails server-side reports itself as a `system.notice` in the
   * chat and emits no `preview.ready` at all, and a pane claiming to be starting a dev server
   * that nothing is starting is the exact bug this whole mechanism exists to fix. Past the
   * ceiling the panes fall back to what the log says — and if the preview does turn up later,
   * it renders, because nothing here can hide an announcement that arrived.
   */
  useEffect(() => {
    if (!waiting) return;

    const timer = setTimeout(() => {
      setAwaitingSince(undefined);
      setResumeError(
        "Starting this project back up is taking longer than usual. It may still come up — or try again.",
      );
    }, RESTORE_CEILING_MS);

    return () => clearTimeout(timer);
  }, [waiting]);

  // `fetchJson` is deliberately not a dependency; see the note in `useProjectFiles`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let abandoned = false;

    // Everything below describes the *previous* project: whether it had been started from this
    // page, which announcement a restore of it was waiting for, and why the last attempt was
    // refused. Carried over, they would say that a project nobody has touched is already on its
    // way up — and the panes would sit waiting for a restore that was never asked for.
    setStarted(false);
    setAwaitingSince(undefined);
    setResumeError(undefined);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: see the note in useProjectFiles
  const resume = useCallback(async (): Promise<void> => {
    setResumeError(undefined);
    setRequesting(true);

    try {
      const response = await fetchJson(`${baseUrl}/projects/${projectId}/open`, { method: "POST" });

      if (!response.ok) {
        setResumeError(await reasonFrom(response, "Could not open the project"));
        return;
      }

      // The record this pane holds was read before any of this and no longer describes the
      // project — whether the restore is under way or somebody else finished one already.
      setStarted(true);

      // 202 means a restore is running and the next `preview.ready` is what ends the wait —
      // recorded here as "everything after whatever is standing now". Anything else means it
      // was already up, so there is nothing to wait for.
      if (response.status === 202) setAwaitingSince(seqNow.current ?? -1);
    } catch {
      setResumeError("Could not open the project — could not reach the server.");
    } finally {
      setRequesting(false);
    }
  }, [baseUrl, projectId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: see the note in useProjectFiles
  const rename = useCallback(
    async (name: string): Promise<string | undefined> => {
      try {
        const response = await fetchJson(`${baseUrl}/projects/${projectId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!response.ok) return undefined;

        // The record this hook holds is updated from the server's answer rather than from the
        // string that was sent: the workspace has no list to reload, and the server trims.
        const updated = ProjectSummarySchema.parse(await response.json());
        setProject(updated);
        return updated.name;
      } catch {
        return undefined;
      }
    },
    [baseUrl, projectId],
  );

  return {
    project,
    status,
    rename,
    putAwayAt:
      !started && project !== undefined && projectState(project) === "put away"
        ? project.updatedAt
        : undefined,
    resume,
    resuming,
    resumeError,
  };
}
