import { describe, expect, it } from "vitest";
import { createStreamTickets } from "./stream-ticket.ts";

const SECRET = "a-secret-long-enough-to-sign-a-cookie-with";
const SESSION = "6f1d2c1e-8a4b-4c39-9d3a-2b7e5f0a1c11";
const OTHER_SESSION = "0b9e7a52-3c1d-4f6e-8a2b-9c4d5e6f7a8b";
const CALLER = { userId: "user-1", isAnonymous: false };

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("stream tickets", () => {
  it("hands back the caller a ticket was issued to, for the session it names", () => {
    const tickets = createStreamTickets(SECRET);

    expect(tickets.verify(tickets.issue(CALLER, SESSION), SESSION)).toEqual(CALLER);
  });

  it("keeps a demo visitor a demo visitor", () => {
    const tickets = createStreamTickets(SECRET);
    const guest = { userId: "guest-1", isAnonymous: true };

    expect(tickets.verify(tickets.issue(guest, SESSION), SESSION)).toEqual(guest);
  });

  it("refuses a ticket presented for a different session", () => {
    // A ticket that leaks — a proxy log, a shared screenshot — opens one stream, not every one.
    const tickets = createStreamTickets(SECRET);

    expect(tickets.verify(tickets.issue(CALLER, SESSION), OTHER_SESSION)).toBeNull();
  });

  it("refuses a ticket once its minute is up", () => {
    const time = clock();
    const tickets = createStreamTickets(SECRET, { now: time.now });
    const ticket = tickets.issue(CALLER, SESSION);

    time.advance(59_999);
    expect(tickets.verify(ticket, SESSION)).toEqual(CALLER);
    time.advance(1);
    expect(tickets.verify(ticket, SESSION)).toBeNull();
  });

  it("refuses a ticket whose claims were edited", () => {
    const tickets = createStreamTickets(SECRET);
    const [, mac] = tickets.issue(CALLER, SESSION).split(".");
    const forged = Buffer.from(
      JSON.stringify({ u: "someone-else", a: false, s: SESSION, e: Date.now() + 60_000 }),
    ).toString("base64url");

    expect(tickets.verify(`${forged}.${mac}`, SESSION)).toBeNull();
  });

  it("refuses a ticket signed with another secret", () => {
    const ticket = createStreamTickets("another-secret-entirely").issue(CALLER, SESSION);

    expect(createStreamTickets(SECRET).verify(ticket, SESSION)).toBeNull();
  });

  it.each(["", "no-dot", "a.b.c", ".", "e30.", "not base64!.c2ln"])(
    "refuses %j rather than throwing",
    (ticket) => {
      expect(createStreamTickets(SECRET).verify(ticket, SESSION)).toBeNull();
    },
  );
});
