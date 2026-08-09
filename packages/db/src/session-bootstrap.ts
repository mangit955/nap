/**
 * Getting a project and a session to exist, so there is something to have a conversation in.
 *
 * **This is a placeholder for project CRUD**, and a deliberately small one. Turn submission
 * needs a session id, a session needs a project, and a project needs a user — three rows that
 * nothing in the app can currently create. Rather than blocking the whole presentation
 * milestone on the persistence one, this makes the three rows and nothing else: no listing,
 * no renaming, no deleting, no ownership.
 *
 * The user is a single fixed row because there is no authentication yet. When there is, the
 * caller passes a real user id, this function loses its find-or-create half, and the endpoint
 * above it becomes an ordinary "create project" scoped to whoever is signed in.
 *
 * The slug carries a random suffix because `(user_id, slug)` is unique and every project here
 * belongs to the same user — a slug derived from the name alone works exactly once.
 */

import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { projects, sessions, users } from "./schema.ts";

/** The stand-in owner, until sign-in exists. */
export const DEV_USER_EMAIL = "dev@nap.local";

export type CreatedSession = {
  sessionId: string;
  projectId: string;
};

export type CreateProjectSessionOptions = {
  name?: string;
  title?: string;
};

const DEFAULT_PROJECT_NAME = "Untitled project";

export async function createProjectSession(
  db: PostgresJsDatabase,
  options: CreateProjectSessionOptions = {},
): Promise<CreatedSession> {
  const name = options.name?.trim() === "" ? undefined : options.name?.trim();
  const projectName = name ?? DEFAULT_PROJECT_NAME;

  return db.transaction(async (tx) => {
    const userId = await findOrCreateDevUser(tx);

    const [project] = await tx
      .insert(projects)
      .values({ userId, name: projectName, slug: slugify(projectName) })
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

/**
 * `on conflict do nothing` then read, rather than reading first: two requests arriving
 * together would both find no user and both insert, and the second would fail on the unique
 * index. Letting the database settle it means the loser simply reads the winner's row.
 */
async function findOrCreateDevUser(db: PostgresJsDatabase): Promise<string> {
  const [inserted] = await db
    .insert(users)
    .values({ email: DEV_USER_EMAIL, name: "Nap dev" })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id });

  if (inserted !== undefined) return inserted.id;

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, DEV_USER_EMAIL))
    .limit(1);
  if (existing === undefined) throw new Error("dev user neither inserted nor found");

  return existing.id;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return `${base === "" ? "project" : base}-${crypto.randomUUID().slice(0, 8)}`;
}
