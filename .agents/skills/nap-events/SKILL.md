---
name: nap-events
description: Use when writing or testing anything that emits, stores, orders, replays or renders Nap events — event schemas, sandbox-proxy tools, AgentService, Runtime, EventStore, EventBus, the WebSocket endpoint, or the chat pane. Triggers on "event", "seq", "turn.started", "tool.call", "replay", "event ordering", "expectEventSequence", "append", "publish".
---

# Testing Nap's event system

`events` is the most load-bearing table in the system: chat transcript, agent audit log, WebSocket replay source, and v2's memory substrate — all one table (`events` in `packages/db/src/schema.ts`). Bugs here are silent and corrupt history rather than crashing.

## Event contracts

**`packages/shared/src/events.ts` is the only list of event types.** `NapEventSchema` is one Zod discriminated union on `type`; read it for the current members and their payloads, and import from it rather than hand-writing an event literal's type. This skill does not repeat the list, because a copy goes stale the first time a member is added.

Every event is the same envelope — `{ type, sessionId, turnId, seq, createdAt, payload }` — mirroring the `events` row one-to-one, so `EventStore` append/read is a straight mapping. `seq` is assigned by `EventStore.append`, not by the emitter.

Closed sets are exported from the same module. Derive tool names from `TOOL_NAMES` and failure reasons from `TurnFailureReasonSchema`; read the event schemas for change types, output streams and notice levels. Adding a value is a deliberate schema change, and every exhaustive consumer must handle it.

**Two rules when you extend this, both about surviving Postgres `jsonb`:** no `Date` and no `undefined` (timestamps are ISO-8601 strings, absent values are `null`), and payloads are `strictObject` so an unknown key is rejected rather than silently dropped on the way into the log. The schema tests below prove both.

## The one rule that governs everything here

**Never assert on model prose.** Assert on:

- tool call sequences
- event **types** and their **ordering**
- filesystem effects

Model output is not deterministic and not a contract. A test that asserts on wording will either be flaky or be silently weakened until it asserts nothing. `ScriptedLLMProvider` exists precisely so agent-loop tests never need to.

## Schema tests — the four assertions

Every event type gets all four. `packages/shared/src/events.test.ts` runs them over a typed `CASES` table, and a compile-time check there fails when a union member has no case. Add the new event to that table and to every downstream exhaustive consumer.

1. A valid fixture **parses**.
2. A malformed fixture **rejects with a useful issue path** — assert the path, not just that it threw. "It failed" doesn't tell a future debugger which field was wrong.
3. The discriminated union **resolves to the right member** for that `type`, *and* rejects that type paired with a structurally foreign payload. Pick the foreign payload deliberately: `user.message`, `agent.thinking` and `agent.message` all carry `{ text }` and are interchangeable at the payload level by design.
4. **Round-trip identity:** `parse(JSON.parse(JSON.stringify(x)))` deep-equals `x`. Use `toStrictEqual`, not `toEqual` — `toEqual` treats a dropped `undefined` key as equal to a present one, which is the exact `jsonb` bug this assertion exists to catch. It also catches `Date` fields: swapping `createdAt` to `z.coerce.date()` was observed failing the round-trip assertions.

## The invariants, and where they are tested

These are the assertions worth protecting when a deadline tempts you to delete a test.

| Invariant | Tested in | Why it matters |
|---|---|---|
| **Append, then publish** — durable write completes *before* fanout | `packages/runtime/src/event-sink.test.ts` | A client that receives an event never persisted sees history that doesn't exist. One of the two most valuable tests in the codebase. |
| **Zero commits on a failed turn** | `packages/runtime/src/single-agent-runtime.test.ts` | The other most valuable test. A failed turn must leave the workspace at the last good commit. |
| **`seq` monotonic, no gaps, per session** | `packages/db/src/postgres-event-store.db.test.ts` | Replay and dedupe both key off `seq`. A gap means a client waits forever; a duplicate means a doubled message. |
| **Replay-then-tail: no duplicates, no gaps** | `apps/api/src/ws/event-stream.test.ts` | The correctness heart of the streaming layer. Connect at `seq=5` with 10 events stored → exactly 5 replayed, then live. |
| **Concurrent appends never collide** | `packages/db/src/postgres-event-store.db.test.ts` | A hundred parallel writers. The `(session_id, seq)` unique index is the backstop; the test proves the code respects it. |
| **Optimistic message reconciles without duplicating** | `apps/web/src/chat/use-turn-submission*.test.tsx` | Where duplicate-message bugs live. |

Assert ordering with a **recording spy**, not by inspecting final state — "append happened before publish" is invisible once both have finished.

## Conventions

- Ordering assertions go through **`expectEventSequence(events, types)`** from `@nap/db/testing/event-assertions`, alongside `InMemoryEventStore`, `InMemoryEventBus` and `InMemorySessionStore` in `packages/db/src/testing/`. Use it rather than hand-rolling index comparisons, so a failure prints both sequences.
- Fakes live in `packages/*/src/testing/` and are exported. They are production-quality code — treat a bug in a fake as seriously as one in `src/`.
- Tool events come in pairs: `tool.call` then `tool.result`. A failure emits a `tool.result` **marked as error** — it does not throw. An unpaired `tool.call` is a legitimate in-progress state the UI must render.
- Writes additionally emit `file.changed` carrying a unified diff.
- `run_command` streams `command.output` chunks **in order**.

## Determinism

Event tests must be deterministic and free. If it needs the network it belongs in `bun run test:integration`, not the unit suite.

An ordering test that only usually passes has already failed: run a new one ten times in a row before trusting it. Chase the nondeterminism (unawaited promise, real timer, shared mutable fake) rather than re-running until green.
