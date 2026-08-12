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
 * What a rename may say.
 *
 * Trimmed before the length is checked, so a name of spaces is refused rather than stored. The
 * ceiling is 60 because both places that show a name — the workspace bar and the dashboard card
 * — truncate, and a name nobody can read whole in either is not doing its job.
 */
export const RenameProjectSchema = z.strictObject({
  name: z
    .string()
    .transform((text) => text.trim())
    .refine((text) => text.length > 0, { message: "name must not be empty" })
    .refine((text) => text.length <= 60, { message: "name must be 60 characters or fewer" }),
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
