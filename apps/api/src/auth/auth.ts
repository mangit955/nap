/**
 * Who is asking. Email and password, or GitHub.
 *
 * A factory rather than a module-level instance, for the reason every other component here
 * takes its dependencies: it is what lets the tests build one against a throwaway database
 * instead of whatever `DATABASE_URL` happens to point at.
 *
 * **The library is mapped onto this repo's tables rather than allowed to generate its own.**
 * Three things make that necessary and all three are easy to get wrong:
 *
 *   - `projects.user_id` is a uuid with a foreign key onto `users`, and the whole persistence
 *     milestone rests on it. The default schema would have made a second, differently-keyed
 *     identity table beside it.
 *   - **`sessions` already means a conversation here.** The adapter resolves a model by
 *     looking its name up as a key in the schema object, so the `modelName` below is what
 *     keeps sign-ins out of the chat table. It pairs with passing an explicit four-key schema
 *     rather than the whole one: together they turn a wrong mapping into a loud "model not
 *     found" instead of a quiet write into `sessions`. Removing either alone is the bad case.
 *   - Ids are generated as real uuids (`generateId: "uuid"`), not the library's default random
 *     strings, which a uuid column would reject on the first insert.
 *
 * The field names in the mapping are *drizzle property* names, not SQL column names — the
 * adapter indexes the table object, and drizzle already knows each column's real name.
 */

import type { Database } from "@nap/db/client";
import { accounts, authSessions, users, verifications } from "@nap/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { anonymous } from "better-auth/plugins/anonymous";
import { z } from "zod";
import { isCrossSite } from "./cross-site.ts";

/**
 * The connection, as `createDatabase` hands it over. Taken from there rather than imported
 * from drizzle directly, so this app needs no dependency on the driver to name a type.
 */
type Db = Database["db"];

/**
 * Who is asking, as everything downstream needs them.
 *
 * `isAnonymous` rides along with the id because the two are learned in the same lookup and the
 * alternative is a second query per request to answer "is this a demo visitor?". Nothing
 * *authorizes* on it — a demo user owns their projects exactly as anybody else does — it is
 * only ever a hint for the parts of the app that talk about signing up.
 */
export type Caller = { userId: string; isAnonymous: boolean };

/**
 * Resolves the caller from a request's headers, or `null` when there is no valid session.
 *
 * A function rather than the auth instance itself, because it is the only thing authorization
 * needs and a stub of it is two lines — which is what lets every route test run without a
 * database or a real cookie.
 */
export type Authenticate = (headers: Headers) => Promise<Caller | null>;

/** Just enough of the instance for the app to mount it, so callers do not depend on the rest. */
export type AuthInstance = {
  handler: (request: Request) => Promise<Response>;
  /** The session behind a request's cookies, narrowed to the id everything else authorizes on. */
  getUser: Authenticate;
  /**
   * Which social providers this process actually has credentials for.
   *
   * The sign-in page asks, so that it offers a GitHub button only when pressing it would
   * work. The alternative is a button that looks fine and fails at the redirect back, which
   * is the failure this whole pairing rule exists to prevent — and the web app cannot know
   * on its own, because the credentials are the API's.
   */
  socialProviders: string[];
  /**
   * Whether somebody with no account may look around.
   *
   * Asked for by the same page and for the same reason as `socialProviders`: a "try it free"
   * link that leads to a 404 because the plugin is not registered is worse than no link.
   */
  demo: boolean;
};

export type OAuthCredentials = {
  clientId: string;
  clientSecret: string;
};

export type AuthConfig = {
  /** Signs the session cookie. A process without one cannot verify its own cookies. */
  secret: string;
  /** Where this API is reached, which is what OAuth redirect URIs are built from. */
  baseUrl: string;
  /** The web app's origin — a different port in development, so it must be named. */
  webOrigin: string;
  /**
   * Omitted when no GitHub app is configured, in which case the provider is simply not
   * registered and email sign-in still works. A provider wired up with blank credentials
   * would present a button that fails only once somebody presses it.
   */
  github?: OAuthCredentials;
  /** The same arrangement for Google, and omitted for the same reason. */
  google?: OAuthCredentials;
  /**
   * Whether to offer a throwaway identity to somebody who does not want an account.
   *
   * The demo door. What makes it affordable to leave open is not this flag but the free tier
   * behind it — an anonymous visitor reaches the free models and nothing else, under lower
   * ceilings than a signed-in person. See `apps/api/src/turns/model-access.ts`.
   */
  allowAnonymous: boolean;
  /**
   * How many requests one address may make to `/api/auth/*` in ten seconds.
   *
   * The library's own default — 100 per 10s per IP, and only in production — is right for the
   * public deployment: it is the thing standing between the demo door and somebody minting a
   * thousand throwaway identities. It is exactly wrong for a load generator, which arrives from
   * one address by definition: a hundred simulated users signing in at once exhaust it before
   * the run starts, every one of them gets a 429 from the sign-in, and the run reports the
   * system as broken rather than the harness as untenanted.
   *
   * So it is a number the *composition* sets, and only the two fake-infrastructure entrypoints
   * ever raise it. Absent means the library's default, which is what boot passes.
   */
  authRequestsPerWindow?: number;
};

/**
 * The one field of the session's user this app reads, parsed rather than cast.
 *
 * The library types a user as `Record<string, any> & {…}`, so `session.user.isAnonymous` is
 * `any` — and an `any` crossing into `Caller` is exactly the thing the strict-TypeScript rule
 * in `CLAUDE.md` exists to stop. Parsing costs one schema and makes a plugin that stops
 * setting the field read as `false` rather than as `undefined` leaking downstream.
 */
const SessionUserSchema = z.object({ isAnonymous: z.boolean().optional() });

export function createAuth(db: Db, config: AuthConfig): AuthInstance {
  const auth = betterAuth({
    secret: config.secret,
    baseURL: config.baseUrl,
    // The browser is on another origin in development, and the sign-in POST comes from there.
    trustedOrigins: [config.webOrigin],

    // Where a sign-in that fails on this side of the redirect sends the browser. The default
    // is this API's own origin, which serves JSON and guards everything behind a session —
    // so a failed OAuth round trip ends on `{"error":"not signed in"}` at an address the
    // person never typed. The app's sign-in page can at least say what happened.
    onAPIError: { errorURL: `${config.webOrigin}/sign-in` },

    // Left entirely to the library unless a caller says otherwise — see
    // `authRequestsPerWindow`. Naming the window as well as the maximum because the library's
    // default for it is 10 seconds and a maximum without the window it applies to is a number
    // nobody can check.
    //
    // **`customRules` is the load-bearing half, and `max` alone does nothing.** The library
    // ships a default *special* rule capping every path under `/sign-in`, `/sign-up`,
    // `/change-password` and `/change-email` at 3 requests per 10 seconds per IP — which is a
    // good default for a sign-in form and refuses ninety-seven of a hundred simulated users
    // however wide the global maximum is. Only a custom rule overrides it, because custom rules
    // are resolved last.
    //
    // `/**`, not `/*`: the library's glob treats `*` as one path segment, so `/*` matches
    // `/sign-in` and not `/sign-in/anonymous` — which is the one path a load run uses. The rule
    // is applied, matches nothing, and the 3-per-10-seconds default stands.
    ...(config.authRequestsPerWindow === undefined
      ? {}
      : {
          rateLimit: {
            enabled: true,
            window: 10,
            max: config.authRequestsPerWindow,
            customRules: { "/**": { window: 10, max: config.authRequestsPerWindow } },
          },
        }),

    database: drizzleAdapter(db, {
      provider: "pg",
      // Passed explicitly rather than read off the connection, so the four tables the library
      // may touch are the four named here and adding a table elsewhere cannot widen that.
      schema: { users, authSessions, accounts, verifications },
    }),

    advanced: {
      // Ids stay uuids, which is what every foreign key in this schema already expects.
      database: { generateId: "uuid" },
      // When the app and this API are on different hosts, the default `SameSite=Lax` means
      // the browser never sends these cookies back: sign-in looks like it worked and every
      // request after it is a 401.
      //
      // **Deliberately not `Partitioned`**, which is the obvious thing to add here and breaks
      // OAuth outright. A partitioned cookie is keyed to the top-level site that was open
      // when it was set, so the `state` cookie written during the authorize POST is filed
      // under the *app's* site — and the provider's callback is a top-level navigation to
      // *this* API's site, a different partition, where it is not sent. The library reads
      // that as a state cookie that never came back and refuses the sign-in with
      // `state_security_mismatch`, which reaches the browser as `?error=state_mismatch`.
      //
      // Left alone in development, where both are localhost — see `isCrossSite`. Nothing
      // here rescues a browser that blocks third-party cookies outright (Safari, Brave):
      // the fix for those is one site rather than two.
      ...(isCrossSite(config.baseUrl, config.webOrigin)
        ? { defaultCookieAttributes: { sameSite: "none", secure: true } }
        : {}),
    },

    user: { modelName: "users" },
    // The one that matters: see the note above about `sessions` meaning a conversation.
    session: { modelName: "authSessions" },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },

    emailAndPassword: { enabled: true },

    // Assembled as one object rather than spread per provider, so adding a third is a line
    // here and a line in the list below rather than another conditional spread.
    socialProviders: {
      ...(config.github === undefined ? {} : { github: config.github }),
      ...(config.google === undefined ? {} : { google: config.google }),
    },

    // The demo door. Registered conditionally rather than gated at the route, because a
    // plugin that is not registered has no endpoint at all — which is the honest answer to a
    // deployment that turned the demo off, and what `/auth/providers` reports.
    plugins: config.allowAnonymous ? [anonymous()] : [],
  });

  const socialProviders = [
    ...(config.github === undefined ? [] : ["github"]),
    ...(config.google === undefined ? [] : ["google"]),
  ];

  return {
    handler: auth.handler,

    // The library answers with the session *and* the user; only the id and the one flag leave
    // this file, so nothing downstream can start depending on a shape better-auth is free to
    // change.
    getUser: async (headers) => {
      const session = await auth.api.getSession({ headers });
      if (session === null) return null;

      const parsed = SessionUserSchema.safeParse(session.user);
      return {
        userId: session.user.id,
        // Absent means a real account: the column defaults to false, and every row that
        // predates the demo has it. Reading a failed parse the same way is deliberate — the
        // safe answer to "is this a throwaway?" is the one that grants less, not more.
        isAnonymous: parsed.success && parsed.data.isAnonymous === true,
      };
    },

    socialProviders,
    demo: config.allowAnonymous,
  };
}
