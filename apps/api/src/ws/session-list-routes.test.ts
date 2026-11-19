/**
 * `/ws/account` and its ticket, as routes: who may open one, what a ticket for it is good for, and
 * whose notices the socket is bound to. What the socket then says is `session-list-stream.test.ts`.
 */

import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { FAKE_OWNER } from "@nap/db/testing/in-memory-project-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { WSContext, type WSEvents } from "hono/ws";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { Authenticate } from "../auth/auth.ts";
import { ACCOUNT_STREAM, createStreamTickets } from "../auth/stream-ticket.ts";
import { createLogger } from "../logger.ts";
import type { SessionListHub } from "./session-list-hub.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const tickets = createStreamTickets("a-secret-long-enough-to-sign-a-cookie-with");
const owner: Authenticate = async () => ({ userId: FAKE_OWNER, isAnonymous: false });
const nobody: Authenticate = async () => null;

function setup({
  authenticate = owner,
  withHub = true,
}: {
  authenticate?: Authenticate;
  withHub?: boolean;
} = {}) {
  const upgrades: WSEvents[] = [];
  const subscribed: string[] = [];
  const hub: SessionListHub = {
    subscribe: async (userId) => {
      subscribed.push(userId);
      return () => {};
    },
    hearing: () => true,
  };
  const app = createApp({
    logger: createLogger({ level: "silent" }, { write: () => {} }),
    authenticate,
    stream: {
      store: new InMemoryEventStore(),
      bus: new InMemoryEventBus(),
      sessions: new InMemorySessionStore([{ sessionId: SESSION, projectId: "project-1" }]),
      upgradeWebSocket: async (_c, events) => {
        upgrades.push(events);
        return new Response(null);
      },
      tickets,
      ...(withHub ? { sessionList: hub } : {}),
    },
  });
  /** Opens whatever the route upgraded, as Bun would, so its subscription can be read. */
  const open = () => {
    for (const events of upgrades)
      events.onOpen?.(
        new Event("open"),
        new WSContext({ send: () => {}, close: () => {}, readyState: 1 }),
      );
  };
  return { app, upgrades, subscribed, open };
}

describe("/ws/account", () => {
  it("opens for the signed-in caller, bound to their own list", async () => {
    const { app, upgrades, subscribed, open } = setup();

    const res = await app.request("/ws/account");
    open();
    await Promise.resolve();

    expect(res.status).toBe(200);
    expect(upgrades).toHaveLength(1);
    expect(subscribed).toEqual([FAKE_OWNER]);
  });

  it("refuses somebody who is not signed in, before any upgrade", async () => {
    const { app, upgrades } = setup({ authenticate: nobody });

    expect((await app.request("/ws/account")).status).toBe(401);
    expect(upgrades).toEqual([]);
  });

  it("does not exist on an app composed without notices", async () => {
    const { app } = setup({ withHub: false });

    expect((await app.request("/ws/account")).status).toBe(404);
    expect((await app.request("/account/stream-ticket", { method: "POST" })).status).toBe(404);
  });
});

describe("account stream tickets", () => {
  it("issues one to whoever is signed in, uncached, good for the account socket", async () => {
    const res = await setup().app.request("/account/stream-ticket", { method: "POST" });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { ticket } = (await res.json()) as { ticket: string };
    expect(tickets.verify(ticket, ACCOUNT_STREAM)).toEqual({
      userId: FAKE_OWNER,
      isAnonymous: false,
    });
    expect(tickets.verify(ticket, SESSION)).toBeNull();
  });

  it("opens the account socket with no cookie at all", async () => {
    const { app, upgrades, subscribed, open } = setup({ authenticate: nobody });
    const ticket = tickets.issue({ userId: FAKE_OWNER, isAnonymous: false }, ACCOUNT_STREAM);

    const res = await app.request(`/ws/account?ticket=${encodeURIComponent(ticket)}`);
    open();
    await Promise.resolve();

    expect(res.status).toBe(200);
    expect(upgrades).toHaveLength(1);
    expect(subscribed).toEqual([FAKE_OWNER]);
  });

  it("will not let a session's ticket open the account socket, nor this one a session", async () => {
    const { app, upgrades } = setup({ authenticate: nobody });
    const sessionTicket = tickets.issue({ userId: FAKE_OWNER, isAnonymous: false }, SESSION);
    const accountTicket = tickets.issue({ userId: FAKE_OWNER, isAnonymous: false }, ACCOUNT_STREAM);

    const account = await app.request(`/ws/account?ticket=${encodeURIComponent(sessionTicket)}`);
    const session = await app.request(
      `/ws?sessionId=${SESSION}&ticket=${encodeURIComponent(accountTicket)}`,
    );

    expect(account.status).toBe(401);
    expect(session.status).toBe(401);
    expect(upgrades).toEqual([]);
  });
});
