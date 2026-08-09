/**
 * The projects somebody has: listing them, making one, putting one away, throwing one out.
 *
 * This is the front door. Everything else in the API is addressed by a session id that the
 * caller must already have, and until now the only way to get one was a placeholder endpoint
 * that made a project as a side effect of starting a conversation. A project is the thing a
 * person actually has, so it is the thing they list, open, close and delete.
 *
 * **Close and delete both refuse while a turn is running**, with a 409. The agent is midway
 * through writing files and its events are still being appended; taking the sandbox away under
 * it produces a half-finished project and a transcript that stops mid-sentence. Waiting is the
 * user's call to make — they can cancel the turn if they mean it. The check is the same
 * `TurnRegistry` the reaper consults, asked across the project's sessions, because a sandbox
 * belongs to the project those sessions share.
 *
 * Deleting is the one destructive operation here, so it reports what it removed rather than an
 * empty 204: how many objects went with it is the only evidence anyone gets that the bytes were
 * cleaned up too.
 */

import { putProjectAway } from "@nap/runtime/close-project";
import { deleteProject } from "@nap/runtime/delete-project";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { ProjectSandboxStore } from "@nap/shared/ports/project-sandbox-store";
import type { ProjectStore, ProjectSummary } from "@nap/shared/ports/project-store";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
import type { Hono } from "hono";
import { z } from "zod";
import { parseProjectId } from "../files/params.ts";
import { getLogger } from "../logger.ts";

export type CreatedProject = { projectId: string; sessionId: string };

export type ProjectRouteDeps = {
  projects: ProjectStore;
  /** The reaper's slice of the same tables — `putProjectAway` records the release through it. */
  projectSandboxes: ProjectSandboxStore;
  snapshots: SnapshotStore;
  objects: ObjectStore;
  sandbox: SandboxManager;
  createProject: (options: { name?: string }) => Promise<CreatedProject>;
  /**
   * True while a turn is running for any of these sessions. Injected because turns are tracked
   * by whatever is serving requests, and a route module has no business knowing how.
   */
  isBusy: (sessionIds: string[]) => boolean;
};

const CreateProjectSchema = z.object({ name: z.string().optional() });

export function registerProjectRoutes(app: Hono, deps: ProjectRouteDeps): void {
  app.get("/projects", async (c) => {
    return c.json({ projects: await deps.projects.list() });
  });

  app.post("/projects", async (c) => {
    const body = CreateProjectSchema.safeParse((await readJson(c.req.raw)) ?? {});
    if (!body.success) {
      return c.json({ error: body.error.issues.map((issue) => issue.message).join("; ") }, 400);
    }

    try {
      const created = await deps.createProject(
        body.data.name === undefined ? {} : { name: body.data.name },
      );
      return c.json(created, 201);
    } catch (error) {
      // Caught rather than left to the error handler so the log names what failed: the client
      // is blocked on this call before it can render anything.
      getLogger().error({ err: error }, "could not create a project");
      return c.json({ error: "could not create a project" }, 500);
    }
  });

  app.get("/projects/:projectId", async (c) => {
    const project = await found(c.req.param("projectId"), deps);
    if (!project.ok) return c.json({ error: project.error.message }, project.error.status);

    return c.json(project.value);
  });

  app.post("/projects/:projectId/close", async (c) => {
    const project = await found(c.req.param("projectId"), deps);
    if (!project.ok) return c.json({ error: project.error.message }, project.error.status);

    if (deps.isBusy(project.value.sessionIds)) {
      return c.json({ error: "a turn is running in this project" }, 409);
    }

    // Already put away. Saying so is not an error — the user asked for a state, and it holds.
    if (project.value.sandboxId === null) return c.json({ closed: false, reason: "not_running" });

    const closed = await putProjectAway({
      projects: deps.projectSandboxes,
      sandbox: deps.sandbox,
      objects: deps.objects,
      snapshots: deps.snapshots,
      projectId: project.value.projectId,
      sandboxId: project.value.sandboxId,
    });

    if (closed.outcome === "failed") {
      getLogger().error({ failure: closed }, "could not close a project");
      return c.json({ error: `could not close the project: ${closed.message}` }, 503);
    }

    return c.json({ closed: true, ...(closed.outcome === "put_away" ? { key: closed.key } : {}) });
  });

  app.delete("/projects/:projectId", async (c) => {
    const projectId = parseProjectId(c.req.param("projectId"));
    if (!projectId.ok) return c.json({ error: projectId.error.message }, 400);

    const project = await deps.projects.get(projectId.value);
    if (project === null) return c.json({ error: "no such project" }, 404);

    if (deps.isBusy(project.sessionIds)) {
      return c.json({ error: "a turn is running in this project" }, 409);
    }

    const removed = await deleteProject({
      projects: deps.projects,
      snapshots: deps.snapshots,
      objects: deps.objects,
      sandbox: deps.sandbox,
      projectId: projectId.value,
    });

    if (!removed.ok) {
      // 503 rather than 500: nothing is wrong with the request, and trying again later is
      // exactly the right thing to do — the delete is written to be safe to repeat.
      getLogger().error({ failure: removed.error }, "could not delete a project");
      return c.json({ error: `could not delete the project: ${removed.error.message}` }, 503);
    }

    return c.json(removed.value);
  });
}

type RouteError = { status: 400 | 404; message: string };

/** The project named by the path, or which kind of "no" to answer with. */
async function found(
  raw: string | undefined,
  deps: ProjectRouteDeps,
): Promise<{ ok: true; value: ProjectSummary } | { ok: false; error: RouteError }> {
  const projectId = parseProjectId(raw);
  if (!projectId.ok) return { ok: false, error: { status: 400, message: projectId.error.message } };

  const project = await deps.projects.get(projectId.value);
  if (project === null) return { ok: false, error: { status: 404, message: "no such project" } };

  return { ok: true, value: project };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
