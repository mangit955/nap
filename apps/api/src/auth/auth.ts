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

/**
 * The connection, as `createDatabase` hands it over. Taken from there rather than imported
 * from drizzle directly, so this app needs no dependency on the driver to name a type.
 */
type Db = Database["db"];

/** Just enough of the instance for the app to mount it, so callers do not depend on the rest. */
export type AuthInstance = {
  handler: (request: Request) => Promise<Response>;
  /**
   * Which social providers this process actually has credentials for.
   *
   * The sign-in page asks, so that it offers a GitHub button only when pressing it would
   * work. The alternative is a button that looks fine and fails at the redirect back, which
   * is the failure this whole pairing rule exists to prevent — and the web app cannot know
   * on its own, because the credentials are the API's.
   */
  socialProviders: string[];
};

export type GithubCredentials = {
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
  github?: GithubCredentials;
};

export function createAuth(db: Db, config: AuthConfig): AuthInstance {
  const auth = betterAuth({
    secret: config.secret,
    baseURL: config.baseUrl,
    // The browser is on another origin in development, and the sign-in POST comes from there.
    trustedOrigins: [config.webOrigin],

    database: drizzleAdapter(db, {
      provider: "pg",
      // Passed explicitly rather than read off the connection, so the four tables the library
      // may touch are the four named here and adding a table elsewhere cannot widen that.
      schema: { users, authSessions, accounts, verifications },
    }),

    advanced: {
      // Ids stay uuids, which is what every foreign key in this schema already expects.
      database: { generateId: "uuid" },
    },

    user: { modelName: "users" },
    // The one that matters: see the note above about `sessions` meaning a conversation.
    session: { modelName: "authSessions" },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },

    emailAndPassword: { enabled: true },

    ...(config.github === undefined ? {} : { socialProviders: { github: config.github } }),
  });

  return {
    handler: auth.handler,
    socialProviders: config.github === undefined ? [] : ["github"],
  };
}
