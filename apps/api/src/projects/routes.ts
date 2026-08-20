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
import { thumbnailKey } from "@nap/runtime/turn-thumbnail";
import { getLogger } from "@nap/shared/logging";
import type { EventBus } from "@nap/shared/ports/event-bus";
import type { EventStore } from "@nap/shared/ports/event-store";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { ProjectSandboxStore } from "@nap/shared/ports/project-sandbox-store";
import type { ProjectStore, ProjectSummary } from "@nap/shared/ports/project-store";
import type { ContinueOptions, Runtime } from "@nap/shared/ports/runtime";
import type { SandboxCapacity } from "@nap/shared/ports/sandbox-capacity";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
import { RenameProjectSchema } from "@nap/shared/projects-protocol";
import type { Hono } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../auth/require-user.ts";
import { parseProjectId } from "../files/params.ts";
import { resolveTurnAccess } from "../turns/model-access.ts";
import type { CallerKeys } from "../turns/routes.ts";
import { checkSandboxQuota, type SandboxLimits } from "../turns/sandbox-quota.ts";

export type CreatedProject = { projectId: string; sessionId: string };

export type ProjectRouteDeps = {
  projects: ProjectStore;
  /** The reaper's slice of the same tables — `putProjectAway` records the release through it. */
  projectSandboxes: ProjectSandboxStore;
  snapshots: SnapshotStore;
  objects: ObjectStore;
  sandbox: SandboxManager;
  createProject: (options: { userId: string; name?: string }) => Promise<CreatedProject>;
  /** Only `resumeSession`: nothing here *starts* a turn, and a wider type would let it. */
  runtime: Pick<Runtime, "resumeSession">;
  /**
   * Who pays for a job an open continues, and which model it may run on.
   *
   * Opening a project can pick a job back up where a restart left it, and that spends tokens —
   * so the same resolution a turn goes through applies here, from the same facts. Omitted means
   * the runtime's default, which is right for a test and for a deployment with no key store; the
   * cost of leaving it out in production is this deployment paying for a BYOK user's repairs.
   */
  models?: {
    keys?: CallerKeys;
    allowedModels: readonly string[];
    freeModel: string;
    defaultModel: string;
  };
  /**
   * The log a close writes `preview.stopped` to. The same store and bus everything else uses —
   * a second pair would append to a log nobody is reading from.
   */
  events: { events: EventStore; bus: EventBus };
  /**
   * Where a closed project's sandbox capacity goes back to.
   *
   * The authoritative ceiling is reserved at the point of creation, so this is the other end of
   * it: a close that destroyed a sandbox without releasing its reservation would leave the
   * deployment counting a project nobody is running. Optional for the same reason `limits` is —
   * absent means uncapped, and boot always passes one.
   */
  capacity?: SandboxCapacity;
  /**
   * The sandbox ceiling, applied to opening a project exactly as it is to starting a turn.
   * Optional for the same reason it is on the turn routes: absent means unlimited, which is a
   * better default in a test than refusing everything, and boot always passes one.
   */
  limits?: {
    /** Counting live sandboxes; the same store this module lists from. */
    projects: ProjectStore;
    sandboxes: SandboxLimits;
  };
  /**
   * True while a turn is running for any of these sessions. Injected because turns are tracked
   * by whatever is serving requests, and a route module has no business knowing how.
   */
  isBusy: (sessionIds: string[]) => boolean;
};

const CreateProjectSchema = z.object({ name: z.string().optional() });

export function registerProjectRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  deps: ProjectRouteDeps,
): void {
  app.get("/projects", async (c) => {
    return c.json({ projects: await deps.projects.list(c.get("userId")) });
  });

  app.post("/projects", async (c) => {
    const body = CreateProjectSchema.safeParse((await readJson(c.req.raw)) ?? {});
    if (!body.success) {
      return c.json({ error: body.error.issues.map((issue) => issue.message).join("; ") }, 400);
    }

    try {
      const created = await deps.createProject({
        userId: c.get("userId"),
        ...(body.data.name === undefined ? {} : { name: body.data.name }),
      });
      return c.json(created, 201);
    } catch (error) {
      // Caught rather than left to the error handler so the log names what failed: the client
      // is blocked on this call before it can render anything.
      getLogger().error({ err: error }, "could not create a project");
      return c.json({ error: "could not create a project" }, 500);
    }
  });

  app.get("/projects/:projectId", async (c) => {
    const project = await found(c.req.param("projectId"), c.get("userId"), deps);
    if (!project.ok) return c.json({ error: project.error.message }, project.error.status);

    return c.json(project.value);
  });

  /**
   * The picture of the project the dashboard draws on its card.
   *
   * Bytes rather than JSON, because the client is an `<img>`: anything else would mean a
   * fetch, a base64 decode and a data URL to show a picture the browser can request itself.
   *
   * **404 is an ordinary answer here.** A project has no thumbnail until a turn has completed
   * in it with a browser configured, so the card asks and falls back to its colour — which is
   * why this must not log or alarm on a miss.
   *
   * Cached hard *and privately*: the client's URL carries the project's `updatedAt`, so a new
   * picture arrives under a new URL and an unchanged one is never re-fetched. Private because
   * a screenshot of somebody's app is theirs, and a shared cache must not hand it to the next
   * caller who guesses the id.
   */
  app.get("/projects/:projectId/thumbnail", async (c) => {
    const project = await found(c.req.param("projectId"), c.get("userId"), deps);
    if (!project.ok) return c.json({ error: project.error.message }, project.error.status);

    const stored = await deps.objects.get(thumbnailKey(project.value.projectId));
    if (!stored.ok) {
      const status = stored.error.code === "not_found" ? 404 : 503;
      return c.json({ error: "no thumbnail for this project" }, status);
    }

    return c.body(toArrayBuffer(stored.value), 200, {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });

  /**
   * Starting a project back up, so its preview and its files are there to look at.
   *
   * **202, and the restore runs detached** — the same shape as starting a turn, and for the
   * same reason: unbundling a project and installing its dependencies is tens of seconds, and
   * everything the user needs to see arrives on the session's event stream anyway. The
   * background promise must be handled, or one bad restore ends the process.
   *
   * The quota is checked here as well as on a turn, because this is the second way to make a
   * sandbox and a ceiling with two doors is not a ceiling.
   */
  app.post("/projects/:projectId/open", async (c) => {
    const project = await found(c.req.param("projectId"), c.get("userId"), deps);
    if (!project.ok) return c.json({ error: project.error.message }, project.error.status);

    // Already up. Saying so is not an error, the same way closing a closed project is not —
    // and starting a second sandbox for a project that has one is how a preview URL that
    // somebody is looking at stops being the one the project is served from.
    if (project.value.sandboxId !== null) {
      return c.json({ opened: false, reason: "already_running" });
    }

    const sessionId = project.value.sessionIds[0];
    if (sessionId === undefined) {
      return c.json({ error: "this project has no conversation to open", code: "no_session" }, 409);
    }

    if (deps.limits !== undefined) {
      const quota = await checkSandboxQuota({
        projects: deps.limits.projects,
        userId: c.get("userId"),
        // Null by definition here — the branch above returned for anything else — and passing
        // it explicitly is what makes the check actually count rather than wave this through.
        sessionSandboxId: null,
        limits: deps.limits.sandboxes,
      });
      if (!quota.allowed) {
        // The same status and the same `code` a refused turn carries, so the browser has one
        // branch for "you have too many projects running" rather than one per route.
        return c.json({ error: quota.message, code: "sandbox_quota_exceeded" }, 409);
      }
    }

    const logger = getLogger();

    // What a continued job would run on. Resolved even though most opens continue nothing: it
    // is one lookup, and the alternative is deciding whose money to spend after the answer is
    // already 202.
    const settings = await continueSettings(deps, c.get("userId"));

    void deps.runtime
      .resumeSession(sessionId, settings)
      .then((outcome) => {
        logger.info({ outcome }, "project open settled");
      })
      .catch((error: unknown) => {
        // A thrown error is a bug in the runtime rather than a failed resume, which is a value.
        logger.error({ err: error }, "opening a project threw");
      });

    return c.json({ opened: true }, 202);
  });

  /**
   * Giving a project a different name.
   *
   * **Deliberately not refused while a turn is running**, unlike close and delete. Those take the
   * sandbox away from underneath an agent that is midway through writing files; a name is a label
   * on a row, and renaming during a turn breaks nothing.
   *
   * Answers the updated record rather than an empty 204, so the client re-renders from what the
   * server actually stored instead of from what it hoped it wrote.
   */
  app.patch("/projects/:projectId", async (c) => {
    const project = await found(c.req.param("projectId"), c.get("userId"), deps);
    if (!project.ok) return c.json({ error: project.error.message }, project.error.status);

    const body = RenameProjectSchema.safeParse((await readJson(c.req.raw)) ?? {});
    if (!body.success) {
      return c.json({ error: body.error.issues.map((issue) => issue.message).join("; ") }, 400);
    }

    const renamed = await deps.projects.rename(
      project.value.projectId,
      c.get("userId"),
      body.data.name,
    );
    // The lookup above found it, so a false here means it went away in between — which is a 404
    // rather than a failure: the answer to "rename this" is that there is nothing to rename.
    if (!renamed) return c.json({ error: "no such project" }, 404);

    return c.json({ ...project.value, name: body.data.name });
  });

  app.post("/projects/:projectId/close", async (c) => {
    const project = await found(c.req.param("projectId"), c.get("userId"), deps);
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
      // So every tab open on this project learns its preview has stopped, rather than keeping
      // an iframe pointed at a sandbox that no longer exists.
      announce: { ...deps.events, sessionIds: project.value.sessionIds },
      ...(deps.capacity === undefined ? {} : { capacity: deps.capacity }),
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

    const project = await deps.projects.get(projectId.value, c.get("userId"));
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
      userId: c.get("userId"),
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

/**
 * What a job continued by this open runs on, and whose account pays for it.
 *
 * The same resolver a turn goes through, asked with no model named: opening a project is not a
 * place to choose one, and the caller's key is the only input. **A refusal cannot happen from
 * here** — the resolver only says no to a model somebody asked for — so there is no error path,
 * and an unconfigured deployment falls through to the runtime's own default.
 */
async function continueSettings(deps: ProjectRouteDeps, userId: string): Promise<ContinueOptions> {
  const models = deps.models;
  if (models === undefined) return {};

  const access = resolveTurnAccess({
    requested: undefined,
    key: (await models.keys?.(userId)) ?? null,
    allowed: models.allowedModels,
    freeModel: models.freeModel,
    defaultModel: models.defaultModel,
  });
  if (!access.ok) return {};

  return {
    model: access.model,
    ...(access.credentials === undefined ? {} : { credentials: access.credentials }),
  };
}

type RouteError = { status: 400 | 404; message: string };

/** The project named by the path, or which kind of "no" to answer with. */
async function found(
  raw: string | undefined,
  userId: string,
  deps: ProjectRouteDeps,
): Promise<{ ok: true; value: ProjectSummary } | { ok: false; error: RouteError }> {
  const projectId = parseProjectId(raw);
  if (!projectId.ok) return { ok: false, error: { status: 400, message: projectId.error.message } };

  // Scoped to the caller, so somebody else's project is a 404 here rather than a 403. The two
  // answers differ in what they tell a stranger: a 403 confirms the project exists.
  const project = await deps.projects.get(projectId.value, userId);
  if (project === null) return { ok: false, error: { status: 404, message: "no such project" } };

  return { ok: true, value: project };
}

/**
 * The bytes as a body Hono will send unchanged.
 *
 * A `Uint8Array` from the object store may be a view onto a larger buffer — its `.buffer` is
 * the whole allocation, not the object — so handing that over sends whatever else happens to
 * be in it. Slicing to the view's own bounds is the difference between a PNG and a PNG with a
 * stranger's bytes stapled to it.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
