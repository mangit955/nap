/**
 * What the project endpoints answer with.
 *
 * Defined once and validated at both ends, like `files-protocol.ts` and `ws-protocol.ts`. The
 * browser cannot import `ProjectStore` — that is a server-side port over a database — but the
 * shape it serialises is a contract between two things that deploy separately, so it lives
 * here rather than being retyped in the client and drifting.
 *
 * `updatedAt` is an ISO string for the reason every timestamp in this codebase is: a `Date`
 * does not survive JSON, and a client that reads one back gets a string whatever the type
 * says.
 */

import { z } from "zod";

export const ProjectStatusSchema = z.enum(["creating", "ready", "idle", "archived", "error"]);

export const ProjectSummarySchema = z.strictObject({
  projectId: z.uuid(),
  name: z.string().min(1),
  status: ProjectStatusSchema,
  /** Null when nothing is running for it, which is the ordinary state of an old project. */
  sandboxId: z.string().min(1).nullable(),
  updatedAt: z.iso.datetime(),
  /** Newest first, so `[0]` is the conversation opening the project lands in. */
  sessionIds: z.array(z.uuid()),
});

export type ProjectSummaryPayload = z.infer<typeof ProjectSummarySchema>;

export const ProjectListSchema = z.strictObject({ projects: z.array(ProjectSummarySchema) });

export const CreatedProjectSchema = z.strictObject({
  projectId: z.uuid(),
  sessionId: z.uuid(),
});

/**
 * Whether a project is running, put away, or has never been opened — in the words a person
 * would use, not the database's.
 *
 * `sandboxId` decides it rather than `status`, because the sandbox is the thing that is
 * actually true: the column is set by whatever last wrote the row, and a project holding a
 * sandbox is running whatever anybody wrote down.
 */
export function projectState(project: ProjectSummaryPayload): "running" | "put away" | "new" {
  if (project.sandboxId !== null) return "running";
  return project.status === "creating" ? "new" : "put away";
}
