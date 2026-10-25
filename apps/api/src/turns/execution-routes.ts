/** Conversation preferences are user intent, never a credential or permission to run a model. */
import { SIGN_IN_REQUIRED } from "@nap/shared/api-error";
import { ExecutionSelectionSchema } from "@nap/shared/execution-target";
import type { SessionExecutionStore } from "@nap/shared/ports/session-execution-store";
import type { Hono } from "hono";
import type { AuthVariables } from "../auth/require-user.ts";
import type { SubscriptionAccess } from "../providers/subscription-access.ts";
export type ExecutionRouteDeps = {
  selections: SessionExecutionStore;
  subscriptions?: SubscriptionAccess;
  allowedModels: readonly string[];
  webOrigin: string;
};
export function registerExecutionRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  deps: ExecutionRouteDeps,
): void {
  app.get("/sessions/:sessionId/execution", async (c) => {
    c.header("cache-control", "no-store");
    const preference = await deps.selections.selection(c.get("userId"), c.req.param("sessionId"));
    return preference === null ? c.json({ error: "No such session." }, 404) : c.json(preference);
  });
  app.patch("/sessions/:sessionId/execution", async (c) => {
    c.header("cache-control", "no-store");
    const userId = c.get("userId");
    const sessionId = c.req.param("sessionId");
    if ((await deps.selections.selection(userId, sessionId)) === null)
      return c.json({ error: "No such session." }, 404);
    if (c.req.header("origin") !== deps.webOrigin)
      return c.json({ error: "Untrusted request origin." }, 403);
    const selection = ExecutionSelectionSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!selection.success) return c.json({ error: "Invalid execution selection." }, 400);
    if (selection.data.kind === "api") {
      if (selection.data.model !== undefined && !deps.allowedModels.includes(selection.data.model))
        return c.json({ error: "This model is unavailable.", code: "model_not_allowed" }, 400);
    } else {
      if (c.get("isAnonymous"))
        return c.json(
          { error: "Sign in to nap to choose a subscription account.", code: SIGN_IN_REQUIRED },
          403,
        );
      if (deps.subscriptions === undefined)
        return c.json(
          { error: "Subscriptions are unavailable here.", code: "subscription_unavailable" },
          503,
        );
      const choice = selection.data;
      const catalog = await deps.subscriptions.catalog(userId);
      const account = catalog.accounts.find((item) => item.account.id === choice.accountId);
      if (account === undefined)
        return c.json(
          { error: "No such provider account.", code: "provider_account_missing" },
          404,
        );
      if (account.models.length === 0)
        return c.json(
          { error: "Subscriptions are unavailable here.", code: "subscription_unavailable" },
          503,
        );
      if (!account.models.some((model) => model.id === choice.model))
        return c.json(
          {
            error: "This model is unavailable for the selected provider.",
            code: "model_not_allowed",
          },
          400,
        );
    }
    if (!(await deps.selections.select(userId, sessionId, selection.data)))
      return c.json({ error: "No such session." }, 404);
    return c.json({ selection: selection.data });
  });
}
