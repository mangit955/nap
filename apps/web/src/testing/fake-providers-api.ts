/**
 * The `/providers` routes, answered in memory, for the settings page's tests.
 *
 * Written against the shared schemas so a response this sends is one the real API could send,
 * and keeping a request log so a test can assert what the page asked for rather than how it drew
 * the answer.
 */

import {
  CompleteProviderSignInSchema,
  CreateProviderAccountSchema,
  type ProviderAccounts,
  type ProviderAccountView,
  type ProviderDriver,
  type ProviderSignIn,
  SIGN_IN_UNAVAILABLE,
  UpdateProviderAccountSchema,
} from "@nap/shared/provider-accounts-protocol";
import { SubmitProviderCodeSchema } from "@nap/shared/provider-auth-input-protocol";
import type { FetchJson } from "../files/use-project-files.ts";

export const FAKE_API = "http://api.test";

export type FakeProvidersApi = {
  fetchJson: FetchJson;
  accounts: ProviderAccountView[];
  requests: { method: string; path: string; body: unknown }[];
  /** What the next sign-in attempt shows. A terminal for Claude, a browser link for Codex. */
  nextSignIn?: (account: ProviderAccountView) => ProviderSignIn;
};

export function fakeProvidersApi(
  options: { signInDrivers?: ProviderDriver[]; accounts?: ProviderAccountView[] } = {},
): FakeProvidersApi {
  const signInDrivers = options.signInDrivers ?? ["claude", "codex"];
  let sequence = 0;
  const api: FakeProvidersApi = {
    accounts: structuredClone(options.accounts ?? []),
    requests: [],
    fetchJson: async (url, init) => {
      const method = init?.method ?? "GET";
      const path = new URL(url).pathname;
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      api.requests.push({
        method,
        path,
        body: path.endsWith("/sign-in/input") ? "[redacted sign-in input]" : body,
      });
      return answer(method, path, body);
    },
  };

  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });

  function answer(method: string, path: string, body: unknown): Response {
    if (method === "GET" && path === "/providers")
      return json({
        signInDrivers,
        checkedAt: "2026-10-23T09:00:00.000Z",
        accounts: api.accounts,
      } satisfies ProviderAccounts);

    if (method === "POST" && path === "/providers/accounts") {
      const input = CreateProviderAccountSchema.parse(body);
      sequence += 1;
      const account: ProviderAccountView = {
        id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
        driver: input.driver,
        label: input.label ?? null,
        enabled: true,
        auth: { status: "unauthenticated", email: null, plan: null },
        createdAt: "2026-10-23T09:00:00.000Z",
        signIn: null,
      };
      api.accounts.push(account);
      return json(account, 201);
    }

    const match =
      /^\/providers\/accounts\/([^/]+)(\/sign-in\/complete|\/sign-in\/input|\/sign-in|\/sign-out)?$/.exec(
        path,
      );
    const account = api.accounts.find((candidate) => candidate.id === match?.[1]);
    if (match === null || account === undefined)
      return json({ error: "No such provider account." }, 404);

    switch (`${method} ${match[2] ?? ""}`) {
      case "PATCH ": {
        const update = UpdateProviderAccountSchema.parse(body);
        if (update.label !== undefined) account.label = update.label;
        if (update.enabled !== undefined) account.enabled = update.enabled;
        return json(account);
      }
      case "DELETE ":
        api.accounts.splice(api.accounts.indexOf(account), 1);
        return new Response(null, { status: 204 });
      case "POST /sign-in":
        if (!signInDrivers.includes(account.driver))
          return json(
            { error: "Signing in is not available here.", code: SIGN_IN_UNAVAILABLE },
            503,
          );
        account.signIn = api.nextSignIn?.(account) ?? {
          flowId: "flow-1",
          phase: "waiting",
          interaction:
            account.driver === "claude"
              ? { type: "terminal", output: "$ claude auth login\nOpening sign-in…" }
              : { type: "browser", url: "https://auth.openai.com/oauth/authorize" },
          message: null,
        };
        return json(account);
      case "POST /sign-in/input": {
        const input = SubmitProviderCodeSchema.safeParse(body);
        if (!input.success) return json({ error: "Invalid sign-in code." }, 400);
        if (
          account.signIn?.flowId !== input.data.flowId ||
          account.signIn.phase !== "waiting" ||
          account.signIn.interaction?.type !== "terminal" ||
          account.signIn.interaction.input !== "code"
        )
          return json({ error: "Sign-in was replaced.", code: "stale" }, 409);
        account.signIn = { ...account.signIn, phase: "verifying", interaction: null };
        return json(account);
      }
      case "POST /sign-in/complete": {
        const input = CompleteProviderSignInSchema.parse(body);
        if (account.signIn?.flowId !== input.flowId || account.signIn.phase !== "waiting")
          return json({ error: "Sign-in was replaced.", code: "stale" }, 409);
        account.signIn = { ...account.signIn, phase: "succeeded", interaction: null };
        account.auth = { status: "authenticated", email: "fixture@example.com", plan: null };
        return json(account);
      }
      case "DELETE /sign-in":
        if (account.signIn !== null)
          account.signIn = { ...account.signIn, phase: "cancelled", interaction: null };
        return json(account);
      case "POST /sign-out":
        account.auth = { status: "unauthenticated", email: null, plan: null };
        return json(account);
      default:
        return json({ error: "Not found." }, 404);
    }
  }

  return api;
}
