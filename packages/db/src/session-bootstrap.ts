/**
 * Getting a project and a session to exist, so there is something to have a conversation in.
 *
 * Turn submission needs a session id, a session needs a project, and a project needs an owner.
 * This makes those two rows for a caller who is already known to be signed in — the owner is
 * passed in, and is not this function's business to establish.
 *
 * It used to invent a fixed `dev@nap.local` user, because there was no sign-in and something had
 * to fill `projects.user_id`. That is gone: a project's owner is now whoever asked for it, and
 * nothing in this codebase creates a user as a side effect of creating something else.
 *
 * The slug carries a random suffix because `(user_id, slug)` is unique, so two projects named
 * the same thing by the same person would otherwise collide on the second one.
 */

import { UNTITLED_PROJECT } from "@nap/shared/project-title";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { projects, sessions } from "./schema.ts";

export type CreatedSession = {
  sessionId: string;
  projectId: string;
};

export type CreateProjectSessionOptions = {
  /** Who the project belongs to. Required: a project with no owner is unreachable by anyone. */
  userId: string;
  name?: string;
  title?: string;
};

export async function createProjectSession(
  db: PostgresJsDatabase,
  options: CreateProjectSessionOptions,
): Promise<CreatedSession> {
  const name = options.name?.trim() === "" ? undefined : options.name?.trim();
  /*
   * The fallback comes from `@nap/shared` rather than a constant here, because the API asks
   * `isUnnamed()` about this exact string when it decides whether to name a project after its
   * first prompt. Two copies is how that check silently stops matching and every project stays
   * untitled forever.
   */
  const projectName = name ?? UNTITLED_PROJECT;

  return db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({ userId: options.userId, name: projectName, slug: slugify(projectName) })
      .returning({ id: projects.id });
    if (project === undefined) throw new Error("insert into projects returned no row");

    const [session] = await tx
      .insert(sessions)
      .values({ projectId: project.id, title: options.title ?? projectName })
      .returning({ id: sessions.id });
    if (session === undefined) throw new Error("insert into sessions returned no row");

    return { sessionId: session.id, projectId: project.id };
  });
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return `${base === "" ? "project" : base}-${crypto.randomUUID().slice(0, 8)}`;
}
