/**
 * Short-lived proof of who is opening `/ws`, for a browser that cannot send the cookie there.
 *
 * In production the web app reaches this API through its own origin — Vercel forwards
 * `/backend/*` here — so the session cookie belongs to the app's host and is first-party in every
 * browser (`docs/DEPLOY.md` § One site for both halves). Vercel does not forward WebSocket
 * upgrades, so the event stream still connects to this API's own host, where that cookie is never
 * sent. The page therefore asks for a ticket over the proxied, cookie-authenticated path and hands
 * it to `/ws` in the query string.
 *
 * A ticket names one caller and one session and lasts a minute. It is in a URL, so it can end up
 * in a platform's access log: bound to a session, a leaked one opens that one stream for what is
 * left of its minute and nothing else — `/ws` still checks the session is the caller's.
 *
 * Stateless — an HMAC over the claims — so any replica can verify a ticket another one issued, and
 * nothing needs cleaning up. Not single-use, which would need shared state for little gain inside
 * a minute. Signed with the auth secret under its own prefix, so a ticket can never be mistaken
 * for anything else that secret signs.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Caller } from "./auth.ts";

export type StreamTickets = {
  issue(caller: Caller, sessionId: string): string;
  /** The caller the ticket was issued to, or `null` for anything not a live ticket for this session. */
  verify(ticket: string, sessionId: string): Caller | null;
};

/** Long enough for a fetch and a socket open on a slow connection; a reconnect asks again. */
const TICKET_TTL_MS = 60_000;

const ClaimsSchema = z.object({
  u: z.string().min(1),
  a: z.boolean(),
  s: z.string(),
  e: z.number().int(),
});

export function createStreamTickets(
  secret: string,
  { now = Date.now }: { now?: () => number } = {},
): StreamTickets {
  const sign = (payload: string) =>
    createHmac("sha256", secret).update(`nap-stream-ticket.v1.${payload}`).digest();

  return {
    issue(caller, sessionId) {
      const claims = {
        u: caller.userId,
        a: caller.isAnonymous,
        s: sessionId,
        e: now() + TICKET_TTL_MS,
      };
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return `${payload}.${sign(payload).toString("base64url")}`;
    },

    verify(ticket, sessionId) {
      const parts = ticket.split(".");
      if (parts.length !== 2) return null;
      const [payload = "", mac = ""] = parts;

      const expected = sign(payload);
      const given = Buffer.from(mac, "base64url");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

      let claims: z.infer<typeof ClaimsSchema>;
      try {
        claims = ClaimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
      } catch {
        return null;
      }
      if (claims.s !== sessionId || claims.e <= now()) return null;
      return { userId: claims.u, isAnonymous: claims.a };
    },
  };
}
