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
  CreateProviderAccountSchema,
  PROVIDER_ACCOUNT_LIMIT,
  PROVIDER_ACCOUNT_LIMIT_REACHED,
  type ProviderAccount,
  type ProviderAccounts,
  type ProviderAccountView,
  SIGN_IN_UNAVAILABLE,
  UpdateProviderAccountSchema,
} from "@nap/shared/provider-accounts-protocol";
import type { Context, Hono } from "hono";
import type { AuthVariables } from "../auth/require-user.ts";
import type { ProviderSignInRunner } from "./sign-in.ts";

export type ProviderRouteDeps = {
  accounts: ProviderAccountStore;
  signIn: ProviderSignInRunner;
  webOrigin: string;
  /** Injected so a test can pin the "Checked …" time. */
  now?: () => Date;
};

export function registerProviderRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  deps: ProviderRouteDeps,
): void {
  const now = deps.now ?? (() => new Date());
  const view = async (userId: string, account: ProviderAccount): Promise<ProviderAccountView> => ({
    ...account,
    signIn: await deps.signIn.current(userId, account),
  });

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

  app.get("/providers", async (c) => {
    const refused = guest(c);
    if (refused !== null) return refused;

    const userId = c.get("userId");
    const accounts = await deps.accounts.list(userId);
    return c.json({
      signInAvailable: deps.signIn.available,
      checkedAt: now().toISOString(),
      accounts: await Promise.all(accounts.map((account) => view(userId, account))),
    } satisfies ProviderAccounts);
  });

  app.post("/providers/accounts", async (c) => {
    const refused = guest(c) ?? forged(c);
    if (refused !== null) return refused;

    const userId = c.get("userId");
    const body = CreateProviderAccountSchema.safeParse(await readJson(c.req.raw));
    if (!body.success) return c.json({ error: "Choose Claude or Codex." }, 400);

    // Counted before the insert rather than inside it: two tabs racing past the limit leave one
    // account too many, which is harmless. The limit is there to stop a runaway list, not to be
    // an invariant anything relies on.
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
    return c.json(await view(userId, account), 201);
  });

  app.patch("/providers/accounts/:accountId", async (c) => {
    const found = await owned(c);
    if (found.refused !== undefined) return found.refused;

    const body = UpdateProviderAccountSchema.safeParse(await readJson(c.req.raw));
    if (!body.success) return c.json({ error: "Nothing to change." }, 400);

    const userId = c.get("userId");
    const account = await deps.accounts.update(userId, found.account.id, body.data);
    if (account === null) return c.json({ error: "No such provider account." }, 404);
    return c.json(await view(userId, account));
  });

  app.delete("/providers/accounts/:accountId", async (c) => {
    const found = await owned(c);
    if (found.refused !== undefined) return found.refused;

    const userId = c.get("userId");
    // Stopped first, so a login finishing a moment later has no account to land on.
    await deps.signIn.cancel(userId, found.account);
    await deps.accounts.remove(userId, found.account.id);
    return c.body(null, 204);
  });

  app.post("/providers/accounts/:accountId/sign-in", async (c) => {
    const found = await owned(c);
    if (found.refused !== undefined) return found.refused;
    if (!deps.signIn.available)
      return c.json(
        {
          error: "Signing in to a provider is not available on this deployment yet.",
          code: SIGN_IN_UNAVAILABLE,
        },
        503,
      );
    if (!found.account.enabled) return c.json({ error: "Switch this provider on first." }, 409);

    const userId = c.get("userId");
    await deps.signIn.start(userId, found.account);
    return c.json(await view(userId, found.account));
  });

  app.delete("/providers/accounts/:accountId/sign-in", async (c) => {
    const found = await owned(c);
    if (found.refused !== undefined) return found.refused;

    const userId = c.get("userId");
    await deps.signIn.cancel(userId, found.account);
    return c.json(await view(userId, found.account));
  });

  app.post("/providers/accounts/:accountId/sign-out", async (c) => {
    const found = await owned(c);
    if (found.refused !== undefined) return found.refused;

    const userId = c.get("userId");
    await deps.signIn.signOut(userId, found.account);
    // Read again: signing out is what changes the account's status, and the page shows the
    // answer it is sent rather than guessing.
    const after = await deps.accounts.get(userId, found.account.id);
    if (after === null) return c.json({ error: "No such provider account." }, 404);
    return c.json(await view(userId, after));
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
