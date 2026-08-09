/**
 * Where a session's project and its live sandbox are looked up, backed by Postgres.
 *
 * The one thing to know here is that **a sandbox belongs to a project, not to a session**.
 * The column is `projects.sandbox_id` (see `schema.ts`), so two conversations about the same
 * project resume the same workspace — which is the behaviour anyone would expect and the
 * reason the port hands back a `projectId` alongside the sandbox at all.
 *
 * Deliberately the two methods the port declares and nothing else. The rest of a project's
 * lifecycle — creating, listing, renaming, archiving — belongs to project CRUD; a wider
 * interface here would mean every caller holding a fake had to implement all of it.
 */

import type { SessionRecord, SessionStore } from "@nap/shared/ports/session-store";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { projects, sessions } from "./schema.ts";

export class PostgresSessionStore implements SessionStore {
  readonly #db: PostgresJsDatabase;

  /** Takes a database rather than a URL, for the reason `PostgresEventStore` does. */
  constructor(db: PostgresJsDatabase) {
    this.#db = db;
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const [row] = await this.#db
      .select({
        sessionId: sessions.id,
        projectId: projects.id,
        sandboxId: projects.sandboxId,
      })
      .from(sessions)
      .innerJoin(projects, eq(sessions.projectId, projects.id))
      .where(eq(sessions.id, sessionId))
      .limit(1);

    return row ?? null;
  }

  async setSandboxId(sessionId: string, sandboxId: string): Promise<void> {
    // A subquery rather than a read followed by a write: the project this session belongs to
    // cannot change, so there is nothing to race against, and one statement means no window
    // where the session was found and the update then hit nothing.
    const updated = await this.#db
      .update(projects)
      // `ready` alongside the id, because a project with a sandbox serving it is what that
      // word means. Without this nothing ever moved a project off `creating`, and every row in
      // a running database claimed to be mid-creation forever.
      .set({ sandboxId, status: "ready", updatedAt: new Date() })
      .where(
        eq(
          projects.id,
          this.#db
            .select({ projectId: sessions.projectId })
            .from(sessions)
            .where(eq(sessions.id, sessionId)),
        ),
      )
      .returning({ id: projects.id });

    // Thrown rather than returned: the caller has already looked this session up, so getting
    // here is a bug above rather than an outcome anyone could handle. The in-memory fake
    // makes the same promise, and a silent no-op would leave the next turn starting over
    // with an empty template and calling it success.
    if (updated.length === 0) throw new Error(`unknown session ${sessionId}`);
  }
}
