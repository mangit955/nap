/**
 * Where the API's sockets are, and the ticket a socket carries when the cookie cannot reach it.
 *
 * In production the page reaches the API through its own origin, so the session cookie belongs to
 * the page's host — and Vercel does not forward WebSocket upgrades, so a socket goes to the API's
 * own host, where that cookie is never sent. The ticket is fetched over the proxied path, where the
 * cookie *is* sent, and lasts a minute. In development both are the same `localhost` and the cookie
 * reaches the socket by itself, so nothing is asked.
 *
 * Whether a ticket is needed is derived from the two URLs rather than configured, so the two cannot
 * disagree.
 */

import { z } from "zod";
import { credentialedFetch } from "./credentialed-fetch.ts";

export const API_WS_URL = process.env.NEXT_PUBLIC_API_WS_URL ?? "ws://localhost:3001";
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** Whether a socket needs a ticket at all: only when it is not on the cookie's host. */
export const SOCKETS_NEED_TICKETS = new URL(API_URL).host !== new URL(API_WS_URL).host;

const TicketSchema = z.object({ ticket: z.string().min(1) });

/** Asks the API for a ticket at `path`; nothing when it refuses, and the socket is then refused. */
export async function fetchSocketTicket(path: string): Promise<string | undefined> {
  const response = await credentialedFetch(`${API_URL}${path}`, {
    method: "POST",
    cache: "no-store",
  });
  if (!response.ok) return undefined;
  return TicketSchema.parse(await response.json()).ticket;
}
