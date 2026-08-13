/**
 * The key somebody brought with them: saving it, seeing that it is there, removing it.
 *
 * **Nothing here ever answers with a key.** Not on `GET`, not as an echo after `PUT`, not in
 * an error message. What a person gets back is `sk-or-…4f2a`, which is enough to recognise
 * their own key and useless to anyone who has stolen a session. The temptation is a "show
 * key" affordance for somebody who wants to check what they saved; the answer is that they
 * can paste it again, and a key that can be read back is a key that leaks through every
 * screen-share, log and browser cache the response passes through.
 *
 * **A key is verified against its vendor before it is stored.** The alternative is a typo that
 * is accepted cheerfully and then fails on every turn, with the failure appearing as "the
 * model is unavailable" three layers away. Verification is one free request — OpenRouter's
 * `/key` and Anthropic's `/models` both cost nothing and spend no tokens — and it turns a
 * mystery into a sentence on the screen where the mistake was made.
 */

import { getLogger } from "@nap/shared/logging";
import type { UserKeyStore } from "@nap/shared/ports/user-key-store";
import type { Hono } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../auth/require-user.ts";
import { hintFor, type KeyPlatform, parseApiKey } from "./api-key.ts";
import { type EncryptionKey, seal } from "./secret-box.ts";

/**
 * Whether a vendor recognises this key.
 *
 * A dependency rather than a direct fetch, for the reason every other outbound call in this
 * repo is injected: a route test that has to reach two vendors' APIs to prove a 400 is a test
 * that belongs in `test:integration` and therefore a test nobody runs.
 */
export type VerifyKey = (key: {
  platform: KeyPlatform;
  apiKey: string;
}) => Promise<{ ok: true } | { ok: false; message: string }>;

export type AccountRouteDeps = {
  keys: UserKeyStore;
  encryptionKey: EncryptionKey;
  verify: VerifyKey;
};

const SaveKeySchema = z.object({ apiKey: z.string().min(1) });

export function registerAccountRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  deps: AccountRouteDeps,
): void {
  app.get("/account/api-key", async (c) => {
    const stored = await deps.keys.get(c.get("userId"));

    return c.json(
      stored === null
        ? { configured: false }
        : { configured: true, platform: stored.platform, hint: stored.hint },
    );
  });

  app.put("/account/api-key", async (c) => {
    const body = SaveKeySchema.safeParse(await readJson(c.req.raw));
    if (!body.success) return c.json({ error: "Paste a key first." }, 400);

    const parsed = parseApiKey(body.data.apiKey);
    if (!parsed.ok) return c.json({ error: parsed.message }, 400);

    const verified = await deps.verify(parsed.value);
    if (!verified.ok) return c.json({ error: verified.message, code: "key_rejected" }, 400);

    const sealed = seal(parsed.value.apiKey, deps.encryptionKey);
    const stored = await deps.keys.put({
      userId: c.get("userId"),
      platform: parsed.value.platform,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      hint: hintFor(parsed.value.apiKey),
    });

    // The same body `GET` answers with, so the browser has nothing to reload — and pointedly
    // not the key it was just sent.
    return c.json({ configured: true, platform: stored.platform, hint: stored.hint });
  });

  app.delete("/account/api-key", async (c) => {
    await deps.keys.remove(c.get("userId"));
    // Not a 204: the browser reads this body to update the picker, and "you are back on the
    // free tier" is the state that answer describes.
    return c.json({ configured: false });
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

/**
 * Just enough of `fetch` to make one request.
 *
 * Narrower than `typeof fetch` on purpose: that type carries `preconnect`, so a two-line stub
 * in a test fails to satisfy it and the only ways out are a cast or a fake `preconnect` — both
 * of which say something false about what this needs.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Where each vendor will say whether a key is real, for free. */
const VERIFY_ENDPOINTS: Record<
  KeyPlatform,
  { url: string; headers: (key: string) => Record<string, string> }
> = {
  openrouter: {
    url: "https://openrouter.ai/api/v1/key",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/models?limit=1",
    headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  },
};

/**
 * The real check: ask the vendor whether it knows this key.
 *
 * **A network failure is not a bad key.** If the vendor cannot be reached, the key is accepted
 * — refusing it would mean nobody can save a key while OpenRouter is having a bad afternoon,
 * and the cost of being wrong is a turn that fails with the vendor's own message. That is the
 * right way round: this check exists to catch typos, not to be a gate.
 */
export function createKeyVerifier(fetchImpl: FetchLike = fetch): VerifyKey {
  return async ({ platform, apiKey }) => {
    const endpoint = VERIFY_ENDPOINTS[platform];

    try {
      const response = await fetchImpl(endpoint.url, {
        headers: endpoint.headers(apiKey),
        // A verification that hangs holds the request open behind it. Five seconds is well
        // past both vendors' normal latency and well short of anybody's patience.
        signal: AbortSignal.timeout(5_000),
      });

      if (response.ok) return { ok: true };

      // 401 and 403 are the answer this exists for; anything else is the vendor having a
      // problem, which is not this key's fault.
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: "That key was refused. Check you copied all of it." };
      }

      getLogger().warn({ platform, status: response.status }, "key verification was inconclusive");
      return { ok: true };
    } catch (error) {
      // Deliberately not logged with the key anywhere near it.
      getLogger().warn({ err: error, platform }, "could not reach the vendor to verify a key");
      return { ok: true };
    }
  };
}
