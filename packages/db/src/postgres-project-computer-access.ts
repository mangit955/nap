import type { ProjectComputerAccess } from "@nap/shared/ports/project-computer-access";
import type { Result } from "@nap/shared/result";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { PostgresTurnQueue } from "./postgres-turn-queue.ts";
import { projects, sessions } from "./schema.ts";

export class PostgresProjectComputerAccess implements ProjectComputerAccess {
  readonly #db: PostgresJsDatabase;

  constructor(db: PostgresJsDatabase) {
    this.#db = db;
  }

  async withIdleProject<T>(
    request: { projectId: string; userId: string },
    operation: (computer: { sandboxId: string | null; revision: string }) => Promise<T>,
  ): Promise<Result<T, { code: "busy" | "not_found" }>> {
    return this.#db.transaction<Result<T, { code: "busy" | "not_found" }>>(async (tx) => {
      const [project] = await tx
        .select({ sandboxId: projects.sandboxId, revision: projects.computerRevision })
        .from(projects)
        .where(and(eq(projects.id, request.projectId), eq(projects.userId, request.userId)))
        .for("update");
      if (project === undefined) return { ok: false, error: { code: "not_found" } };

      // Claim locks this same row before granting a lease. The check and the awaited action
      // therefore cannot straddle a grant, even when the worker uses a different process.
      const projectSessions = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.projectId, request.projectId));
      if (await new PostgresTurnQueue(tx).anyLeased(projectSessions.map(({ id }) => id))) {
        return { ok: false, error: { code: "busy" } };
      }
      return { ok: true, value: await operation(project) };
    });
  }
}
