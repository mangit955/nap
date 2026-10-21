import { z } from "zod";
import { RepositoryImportSchema } from "./github-protocol.ts";
import { MediaAttachmentsSchema } from "./media.ts";

export const InitialPromptSchema = z.object({
  message: z.string().trim().min(1).max(100_000),
  model: z.string().min(1).optional(),
  attachments: MediaAttachmentsSchema.optional(),
});

export const SessionStartSchema = z
  .object({
    operationId: z.uuid(),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("template") }),
      RepositoryImportSchema.extend({ kind: z.literal("github") }),
    ]),
    prompt: InitialPromptSchema.optional(),
  })
  .refine((value) => value.source.kind === "github" || value.prompt !== undefined, {
    message: "Describe a task to start a new session.",
  });
export type SessionStart = z.infer<typeof SessionStartSchema>;

export const SessionStartedSchema = z.object({
  projectId: z.uuid(),
  sessionId: z.uuid(),
  requestId: z.uuid(),
});
export type SessionStarted = z.infer<typeof SessionStartedSchema>;
