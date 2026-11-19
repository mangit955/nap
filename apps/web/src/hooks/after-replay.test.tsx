import type { StoredEvent } from "@nap/shared/ports/event-store";
import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { ev } from "../testing/events.ts";
import { SETTLED_MS, useAfterReplay } from "./after-replay.ts";

const S1 = "5509bb3b-712e-4190-bc00-ed964702c8d1";
const S2 = "96f33335-43e1-4ecb-b0b5-b02fcfa7e7e9";
const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const OLD = new Date(NOW - SETTLED_MS * 10).toISOString();
const RECENT = new Date(NOW - 2_000).toISOString();

const isNotice = (event: StoredEvent) => event.type === "system.notice";
const notice = (seq: number, sessionId: string, createdAt = OLD) =>
  ev("system.notice", { level: "info", text: `n${seq}` }, seq, { sessionId, createdAt });
const filler = (seq: number, sessionId: string) =>
  ev("agent.message", { text: "." }, seq, { sessionId, createdAt: OLD });

type Props = { events: StoredEvent[]; replayed: boolean; session: string | undefined };

function track(initial: Props) {
  const seen: number[] = [];
  const view = renderHook(
    ({ events, replayed, session }: Props) => {
      const value = useAfterReplay(events, isNotice, replayed, session, () => NOW);
      seen.push(value);
      return value;
    },
    { initialProps: initial },
  );
  return { seen, rerender: view.rerender };
}

it("stays 0 through a replay of settled history and moves for what comes after it", () => {
  const history = [notice(1, S1), filler(2, S1), notice(3, S1)];
  const { seen, rerender } = track({ events: [], replayed: false, session: S1 });
  rerender({ events: history, replayed: true, session: S1 });
  rerender({ events: history, replayed: true, session: S1 });
  expect(seen.every((value) => value === 0)).toBe(true);

  rerender({ events: [...history, notice(4, S1, RECENT)], replayed: true, session: S1 });
  expect(seen.at(-1)).toBe(4);
});

it("counts a replayed notice too recent to be in the first reads as news", () => {
  // Stored after the record was read and before the socket subscribed: in the replay, in neither
  // read, so it must still move the key once.
  const { seen, rerender } = track({ events: [], replayed: false, session: S1 });
  rerender({ events: [notice(1, S1), notice(2, S1, RECENT)], replayed: true, session: S1 });
  expect(seen.at(-1)).toBe(2);
});

it("measures a new session from its own replay, in the order the stream really reports it", () => {
  const first = [notice(1, S1), filler(2, S1), filler(3, S1), notice(40, S1)];
  const { seen, rerender } = track({ events: first, replayed: true, session: S1 });
  // The stream says `replayed` for the session it was replayed for, so the switch arrives as not
  // replayed (`use-event-stream.ts`), then the new session's replay, then its live notices.
  rerender({ events: [], replayed: false, session: S2 });
  rerender({ events: [notice(5, S2)], replayed: true, session: S2 });
  expect(seen.at(-1)).toBe(0);
  rerender({ events: [notice(5, S2), notice(6, S2, RECENT)], replayed: true, session: S2 });
  // Below the last session's newest notice, and still news: no baseline was carried over.
  expect(seen.at(-1)).toBe(6);
});
