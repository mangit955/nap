/**
 * The Claude and ChatGPT accounts somebody connected: listing them, adding one, renaming it,
 * switching it off, and running the provider's own sign-in on it.
 *
 * Shaped after T3 Code's provider instances, so a person can keep a "Personal" and a "Work"
 * account of the same provider side by side and sign each in separately.
 *
 * **A guest cannot connect anything.** An anonymous account disappears with its cookie, and a
 * subscription signed in under it would be a login nobody could find again to sign out of. Every
 * route answers a guest with `SIGN_IN_REQUIRED`, which the page turns into a sign-in prompt.
 *
 * **A change must come from the web app's own origin.** The session cookie is sent cross-site in
 * production, and starting a sign-in is a bodiless POST — exactly the request another site could
 * forge. GitHub's routes check the same thing for the same reason.
 */

import { SIGN_IN_REQUIRED, type SignInRequired } from "@nap/shared/api-error";
import type { ProviderAccountStore } from "@nap/shared/ports/provider-account-store";
import {
  CompleteProviderSignInSchema,
  CreateProviderAccountSchema,
  PROVIDER_ACCOUNT_LIMIT,
  PROVIDER_ACCOUNT_LIMIT_REACHED,
  type ProviderAccount,
  type ProviderAccounts,
  type ProviderAccountView,
  SIGN_IN_UNAVAILABLE,
  UpdateProviderAccountSchema,
} from "@nap/shared/provider-accounts-protocol";
import { SubmitProviderCodeSchema } from "@nap/shared/provider-auth-input-protocol";
import type { Context, Hono } from "hono";
import type { AuthVariables } from "../auth/require-user.ts";
import type {
  ProviderSignInError,
  ProviderSignInRunner,
  ProviderSignInSession,
} from "./sign-in.ts";

import { SubscriptionAccess } from "./subscription-access.ts";

export type ProviderRouteDeps = {
  accounts: ProviderAccountStore;
  signIn: ProviderSignInRunner;
  subscriptions?: SubscriptionAccess;
  webOrigin: string;
  /** Injected so a test can pin the "Checked …" time. */
  now?: () => Date;
};

export function registerProviderRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  deps: ProviderRouteDeps,
): void {
  const now = deps.now ?? (() => new Date());
  const subscriptions = deps.subscriptions ?? new SubscriptionAccess({ accounts: deps.accounts });
  const session = (c: Context<{ Variables: AuthVariables }>): ProviderSignInSession | null => {
    const id = c.get("authSessionId");
    return typeof id === "string" && id.length > 0
      ? { userId: c.get("userId"), authSessionId: id }
      : null;
  };
  const view = async (
    c: Context<{ Variables: AuthVariables }>,
    account: ProviderAccount,
  ): Promise<ProviderAccountView | null> => {
    const binding = session(c);
    c.header("cache-control", "no-store");
    const signIn = binding === null ? null : await deps.signIn.current(binding, account);
    const after = await deps.accounts.get(c.get("userId"), account.id);
    return after === null ? null : { ...after, signIn };
  };
  const respond = async (
    c: Context<{ Variables: AuthVariables }>,
    account: ProviderAccount,
    status: 200 | 201 = 200,
  ) => {
    const value = await view(c, account);
    return value === null
      ? c.json({ error: "No such provider account." }, 404)
      : c.json(value, status);
  };
  const sessionRequired = (c: Context<{ Variables: AuthVariables }>) =>
    c.json(
      {
        error: "Sign in to nap again before connecting a provider.",
        code: SIGN_IN_REQUIRED,
      } satisfies SignInRequired,
      403,
    );

  const signInRefusal = (c: Context<{ Variables: AuthVariables }>, error: ProviderSignInError) => {
    const failures = {
      missing: { status: 404, message: "No such sign-in attempt." },
      disabled: { status: 409, message: "Switch this provider on first." },
      stale: { status: 409, message: "This sign-in was replaced or disconnected. Start again." },
      expired: { status: 410, message: "Sign-in expired. Start again." },
      unavailable: { status: 503, message: "Signing in to this provider is unavailable here." },
      invalid_callback: {
        status: 400,
        message: "This callback does not match the sign-in request.",
      },
    } satisfies Record<
      ProviderSignInError["code"],
      { status: 400 | 404 | 409 | 410 | 503; message: string }
    >;
    const failure = failures[error.code];
    return c.json({ error: failure.message, code: error.code }, failure.status);
  };

  /**
   * The two refusals every route makes, in the order that leaks nothing: a guest is told to sign
   * in before anything is looked up, and a forged origin is refused only *after* the account is
   * found to be the caller's — so a stranger's request is the same 404 whatever site sent it.
   * Checked in each handler rather than as middleware, because Hono records middleware as a
   * route and the coverage test would have to classify a path nobody can call.
   */
  const guest = (c: Context<{ Variables: AuthVariables }>) =>
    c.get("isAnonymous")
      ? c.json(
          {
            error: "Sign in to a permanent nap account to connect a provider.",
            code: SIGN_IN_REQUIRED,
          } satisfies SignInRequired,
          403,
        )
      : null;
  const forged = (c: Context<{ Variables: AuthVariables }>) =>
    c.req.header("origin") === deps.webOrigin
      ? null
      : c.json({ error: "Untrusted request origin." }, 403);

  /** The caller's account named in the path, or the response that refuses the request. */
  const owned = async (c: Context<{ Variables: AuthVariables }>) => {
    const refused = guest(c);
    if (refused !== null) return { refused };
    const account = await deps.accounts.get(c.get("userId"), c.req.param("accountId") ?? "");
    if (account === null) return { refused: c.json({ error: "No such provider account." }, 404) };
    const untrusted = forged(c);
    return untrusted === null ? { account } : { refused: untrusted };
  };

  app.get("/providers/targets", async (c) => {
    c.header("cache-control", "no-store");
    const refused = guest(c);
    if (refused !== null) return refused;
    return c.json(await subscriptions.catalog(c.get("userId")));
  });

  app.get("/providers", async (c) => {
    c.header("cache-control", "no-store");
    const refused = guest(c);
    if (refused !== null) return refused;

    const userId = c.get("userId");
    const accounts = await deps.accounts.list(userId);
    return c.json({
      signInDrivers: [...deps.signIn.drivers],
      checkedAt: now().toISOString(),
      accounts: (await Promise.all(accounts.map((account) => view(c, account)))).filter(
        (account) => account !== null,
      ),
    } satisfies ProviderAccounts);
  });

  app.post("/providers/accounts", async (c) => {
    const refused = guest(c) ?? forged(c);
    if (refused !== null) return refused;

    const userId = c.get("userId");
    const body = CreateProviderAccountSchema.safeParse(await readJson(c.req.raw));
    if (!body.success) return c.json({ error: "Choose Claude or Codex." }, 400);

    // Counted before the insert: concurrent creates can each pass and exceed the limit.
    // These small rows hold no credentials, so this is an advisory cap on ordinary use,
    // not an invariant anything relies on.
    if ((await deps.accounts.list(userId)).length >= PROVIDER_ACCOUNT_LIMIT)
      return c.json(
        {
          error: `You can connect up to ${PROVIDER_ACCOUNT_LIMIT} provider accounts. Remove one first.`,
          code: PROVIDER_ACCOUNT_LIMIT_REACHED,
        },
        409,
      );

    const account = await deps.accounts.create({
      userId,
      driver: body.data.driver,
      label: body.data.label ?? null,
    });
    return respond(c, account, 201);
  });

  app.patch("/providers/accounts/:accountId", async (c) => {
    const found = await owned(c);
    if (found.refused !== undefined) return found.refused;

    const body = UpdateProviderAccountSchema.safeParse(await readJson(c.req.raw));
    if (!body.success) return c.json({ error: "Nothing to change." }, 400);

    const userId = c.get("userId");
    const account = await deps.accounts.update(userId, found.account.id, body.data);
    if (account === null) return c.json({ error: "No such provider account." }, 404);
    return respond(c, account);
  });

  app.delete("/providers/accounts/:accountId", async (c) => {
    const found = await owned(c);
    if (found.refused !== undefined) return found.refused;

    const userId = c.get("userId");
    // Stopped first, so a login finishing a moment later has no account to land on.
    const binding = session(c);
    if (binding !== null) await deps.signIn.cancel(binding, found.account);
    await deps.accounts.revokeAuthorization(userId, found.account.id);
    await deps.signIn.signOut(userId, found.account);
    await deps.accounts.remove(userId, found.account.id);
    return c.body(null, 204);
  });

  app.post("/providers/accounts/:accountId/sign-in", async (c) => {
    const found = await owned(c);
    if (found.refused !== undefined) return found.refused;
    if (!deps.signIn.drivers.includes(found.account.driver))
      return c.json(
        {
          error: "Signing in to a provider is not available on this deployment yet.",
          code: SIGN_IN_UNAVAILABLE,
        },
        503,
      );
    if (!found.account.enabled) return c.json({ error: "Switch this provider on first." }, 409);

    const binding = session(c);
    if (binding === null) return sessionRequired(c);
    const result = await deps.signIn.start(binding, found.account);
    if (!result.ok) return signInRefusal(c, result.error);
    return respond(c, found.account);
  });

  app.post("/providers/accounts/:accountId/sign-in/complete", async (c) => {
    const found = await owned(c);
    if (found.refused !== undefined) return found.refused;
    const binding = session(c);
    if (binding === null) return sessionRequired(c);
    const input = CompleteProviderSignInSchema.safeParse(await readJson(c.req.raw));
    if (!input.success) return c.json({ error: "Invalid sign-in callback." }, 400);
    const result = await deps.signIn.complete(binding, found.account, input.data);
    if (!result.ok) return signInRefusal(c, result.error);
    const account = await deps.accounts.get(binding.userId, found.account.id);
    if (account === null) return c.json({ error: "No such provider account." }, 404);
    return respond(c, account);
  });

  app.post("/providers/accounts/:accountId/sign-in/input", async (c) => {
    c.header("cache-control", "no-store");
    const found = await owned(c);
    if (found.refused !== undefined) return found.refused;
    const binding = session(c);
    if (binding === null) return sessionRequired(c);
    if (!found.account.enabled) return c.json({ error: "Switch this provider on first." }, 409);
    if (!deps.signIn.drivers.includes(found.account.driver))
      return signInRefusal(c, { code: "unavailable" });
    const input = SubmitProviderCodeSchema.safeParse(await readJson(c.req.raw));
    if (!input.success) return c.json({ error: "Enter one valid sign-in code." }, 400);
    const result = await deps.signIn.submitCode(binding, found.account, input.data);
    if (!result.ok) return signInRefusal(c, result.error);
    const account = await deps.accounts.get(binding.userId, found.account.id);
    if (account === null) return c.json({ error: "No such provider account." }, 404);
    return respond(c, account);
  });

  app.delete("/providers/accounts/:accountId/sign-in", async (c) => {
    const found = await owned(c);
    if (found.refused !== undefined) return found.refused;

    const binding = session(c);
    if (binding === null) return sessionRequired(c);
    await deps.signIn.cancel(binding, found.account);
    return respond(c, found.account);
  });

  app.post("/providers/accounts/:accountId/sign-out", async (c) => {
    const found = await owned(c);
    if (found.refused !== undefined) return found.refused;

    const userId = c.get("userId");
    await deps.accounts.revokeAuthorization(userId, found.account.id);
    await deps.signIn.signOut(userId, found.account);
    // Read again: signing out is what changes the account's status, and the page shows the
    // answer it is sent rather than guessing.
    const after = await deps.accounts.get(userId, found.account.id);
    if (after === null) return c.json({ error: "No such provider account." }, 404);
    return respond(c, after);
  });
}

/** An unparseable body is a 400 like any other bad input, not a 500. */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
