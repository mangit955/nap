import { createHash } from "node:crypto";
import { MODEL_MEDIA_UNSUPPORTED, modelSupportsImages } from "@nap/shared/model-capabilities";
import type { ProjectStore } from "@nap/shared/ports/project-store";
import type {
  AdmittedSessionStart,
  SessionStartStore,
} from "@nap/shared/ports/session-start-store";
import { titleFromPrompt } from "@nap/shared/project-title";
import { SessionStartSchema } from "@nap/shared/session-start-protocol";
import type { Hono } from "hono";
import type { AuthVariables } from "../auth/require-user.ts";
import type { GitHubApp } from "../github/app.ts";
import type { GitHubIntegration } from "../github/integration.ts";
import { refusalStatus, resolveTurnAccess } from "../turns/model-access.ts";
import type { TurnRouteDeps } from "../turns/routes.ts";
import { checkSandboxQuota } from "../turns/sandbox-quota.ts";

export type SessionStartRouteDeps = {
  store: SessionStartStore;
  projects: ProjectStore;
  webOrigin: string;
  github?: { integration: GitHubIntegration; app: GitHubApp | null } | undefined;
  admission: Pick<
    TurnRouteDeps,
    "keys" | "allowedModels" | "freeModel" | "defaultModel" | "limits"
  >;
};

export function registerSessionStartRoutes(
  router: Hono<{ Variables: AuthVariables }>,
  deps: SessionStartRouteDeps,
): void {
  router.post("/sessions/start", async (c) => {
    if (c.req.header("origin") !== deps.webOrigin)
      return c.json({ error: "Untrusted request origin." }, 403);
    const parsed = SessionStartSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: parsed.error.issues.map((issue) => issue.message).join(" ") }, 400);
    const input = parsed.data;
    const userId = c.get("userId");
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const prior = await deps.store.find(userId, input.operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        return c.json(
          {
            error: "This start request already belongs to a different draft. Start a new session.",
          },
          409,
        );
      if (prior.result === null)
        return c.json({ error: "This session has been deleted. Start a new session." }, 410);
      return c.json(prior.result);
    }
    let source: AdmittedSessionStart["source"] = { kind: "template" };
    if (input.source.kind === "github") {
      if (c.get("isAnonymous"))
        return c.json(
          { error: "Sign in to a permanent nap account to use GitHub repositories." },
          403,
        );
      const github = deps.github;
      if (!github?.app)
        return c.json({ error: "GitHub is not configured on this deployment." }, 503);
      const selected = await github.integration.selectedRepository(
        userId,
        input.source.installationId,
        input.source.repositoryId,
      );
      if (!selected.ok)
        return c.json(
          { error: selected.error.message },
          selected.error.code === "access_denied" ? 403 : 503,
        );
      const branch = await github.app.branch(
        input.source.installationId,
        selected.value.repository,
        input.source.baseBranch,
      );
      if (!branch.ok)
        return c.json({ error: "This branch is not available in the selected repository." }, 400);
      source = {
        kind: "github",
        import: { ...input.source, userId, repository: selected.value.repository },
      };
    }
    const { admission } = deps;
    const key = (await admission.keys?.(userId)) ?? null;
    const access = resolveTurnAccess({
      requested: input.prompt?.model,
      key,
      allowed: admission.allowedModels,
      freeModel: admission.freeModel,
      defaultModel: admission.defaultModel,
    });
    if (!access.ok)
      return c.json({ error: access.message, code: access.code }, refusalStatus(access.code));
    if (input.prompt?.attachments?.length && !modelSupportsImages(access.model))
      return c.json({ error: MODEL_MEDIA_UNSUPPORTED }, 400);
    const limits = admission.limits;
    if (limits) {
      const quota = await checkSandboxQuota({
        projects: deps.projects,
        userId,
        sessionSandboxId: null,
        limits: key === null ? limits.freeSandboxes : limits.sandboxes,
      });
      if (!quota.allowed)
        return c.json({ error: quota.message, code: "sandbox_quota_exceeded" }, 409);
      const rate = await (key === null ? limits.freeRate : limits.rate).check(userId);
      if (!rate.allowed)
        return c.json({ error: "Session allowance reached. Try again later." }, 429, {
          "Retry-After": String(rate.retryAfterSeconds),
        });
    }
    const created = await deps.store.start({
      userId,
      operationId: input.operationId,
      fingerprint,
      source,
      name: input.prompt
        ? titleFromPrompt(input.prompt.message)
        : input.source.kind === "github"
          ? input.source.name
          : "New session",
      request: {
        kind: input.prompt ? "turn" : "resume",
        message: input.prompt?.message ?? null,
        model: access.model,
        billsToUser: access.credentials !== undefined,
        ...(input.prompt?.attachments === undefined
          ? {}
          : { attachments: input.prompt.attachments }),
      },
    });
    if (created.kind === "conflict")
      return c.json({ error: "This start request already belongs to a different draft." }, 409);
    if (created.kind === "deleted") return c.json({ error: "This session has been deleted." }, 410);
    if (created.kind === "access_changed")
      return c.json({ error: "GitHub access changed. Reconnect and try again." }, 409);
    return c.json(
      { projectId: created.projectId, sessionId: created.sessionId, requestId: created.requestId },
      201,
    );
  });
}
