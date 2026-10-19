import { z } from "zod";

export const GitHubIdSchema = z.number().int().positive().safe();
export const GitRefSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (ref) =>
      !ref.startsWith("-") &&
      !ref.startsWith("/") &&
      !ref.endsWith("/") &&
      !ref.endsWith(".") &&
      !ref.endsWith(".lock") &&
      !/[\s~^:?*[\\]/.test(ref) &&
      [...ref].every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ) &&
      !ref.includes("..") &&
      !ref.includes("@{") &&
      !ref.includes("//") &&
      !ref.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")),
    "Use a branch name, without refs/heads/.",
  )
  .refine((ref) => !ref.startsWith("refs/"), "Use a branch name, without refs/heads/.");

export const RepositoryEnvironmentSchema = z
  .object({
    setupCommand: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .nullable()
      .default("bun install --frozen-lockfile"),
    devCommand: z.string().trim().min(1).max(2000).nullable().default(null),
    previewPort: z.number().int().min(1024).max(65535).nullable().default(null),
  })
  .refine(
    (value) => (value.devCommand === null) === (value.previewPort === null),
    "Set both the development command and preview port, or leave both empty.",
  );
export type RepositoryEnvironment = z.infer<typeof RepositoryEnvironmentSchema>;

export const GitHubInstallationSchema = z.object({
  installationId: GitHubIdSchema,
  userId: z.uuid(),
  githubUserId: GitHubIdSchema,
  githubLogin: z.string(),
  accountLogin: z.string(),
  accountType: z.enum(["User", "Organization"]),
  status: z.enum(["active", "suspended", "removed", "disconnected"]),
});
export type GitHubInstallation = z.infer<typeof GitHubInstallationSchema>;

export const GitHubRepositorySchema = z.object({
  id: GitHubIdSchema,
  fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  defaultBranch: GitRefSchema,
  private: z.boolean(),
});
export type GitHubRepository = z.infer<typeof GitHubRepositorySchema>;

export const RepositoryImportSchema = z.object({
  installationId: GitHubIdSchema,
  repositoryId: GitHubIdSchema,
  baseBranch: GitRefSchema,
  name: z.string().trim().min(1).max(100),
  environment: RepositoryEnvironmentSchema,
  autoPublish: z.boolean().default(true),
});
export type RepositoryImport = z.infer<typeof RepositoryImportSchema>;

export const ProjectRepositorySchema = z.object({
  projectId: z.uuid(),
  sessionId: z.uuid(),
  userId: z.uuid(),
  installationId: GitHubIdSchema,
  repository: GitHubRepositorySchema,
  baseBranch: GitRefSchema,
  environment: RepositoryEnvironmentSchema,
  autoPublish: z.boolean(),
});
export type ProjectRepository = z.infer<typeof ProjectRepositorySchema>;

export const RepositoryJobSchema = z.object({
  jobId: z.uuid(),
  projectId: z.uuid(),
  sessionId: z.uuid(),
  baseBranch: GitRefSchema,
  headBranch: GitRefSchema,
  baseSha: z.string(),
  headSha: z.string().nullable(),
  pushedSha: z.string().nullable(),
  pullRequestNumber: z.number().int().positive().nullable(),
  pullRequestUrl: z.url().nullable(),
  pullRequestState: z.enum(["none", "open", "closed", "merged"]),
  publishState: z.enum(["working", "ready", "publishing", "published", "failed"]),
  checkState: z.enum(["unknown", "pending", "passed", "failed"]),
  reviewState: z.enum(["unknown", "approved", "changes_requested", "commented"]),
  error: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type RepositoryJob = z.infer<typeof RepositoryJobSchema>;

export const RepositoryFeedbackSchema = z.object({
  id: z.string(),
  projectId: z.uuid(),
  jobId: z.uuid(),
  kind: z.enum(["comment", "checks", "review"]),
  summary: z.string(),
  requestId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type RepositoryFeedback = z.infer<typeof RepositoryFeedbackSchema>;

export const GitHubConnectionsSchema = z.object({
  configured: z.boolean(),
  installations: z.array(GitHubInstallationSchema),
});
export const GitHubRepositoriesSchema = z.object({ repositories: z.array(GitHubRepositorySchema) });
export const GitHubConnectResponseSchema = z.object({ url: z.url() });
export const ProjectGitHubSchema = z.object({
  repository: ProjectRepositorySchema.nullable(),
  runningPreviewPort: z.number().int().min(1024).max(65535).nullable().optional(),
  jobs: z.array(RepositoryJobSchema),
  feedback: z.array(RepositoryFeedbackSchema),
  followUpPolicy: z.literal("owner_approval"),
});
export type ProjectGitHub = z.infer<typeof ProjectGitHubSchema>;
