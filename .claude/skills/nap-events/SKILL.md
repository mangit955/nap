---
name: nap-events
description: Use when writing or testing anything that emits, stores, orders, replays or renders Nap events — event schemas, sandbox-proxy tools, AgentService, Runtime, EventStore, EventBus, the WebSocket endpoint, or the chat pane. Applies to tasks M0-3, M2-5, M2-7, M2-8, M3-1, M3-2, M3-3, M3-4 and M3-7. Triggers on "event", "seq", "turn.started", "tool.call", "replay", "event ordering", "expectEventSequence", "append", "publish".
---

# Testing Nap's event system

`events` is the most load-bearing table in the system: chat transcript, agent audit log, WebSocket replay source, and v2's memory substrate — all one table (`docs/PLAN.md` §5). Bugs here are silent and corrupt history rather than crashing.

> **Status:** written before M0-3, so it covers *discipline*, not concrete shapes. Once M0-3 lands, add the real event type list and revisit.

## The one rule that governs everything here

**Never assert on model prose.** Assert on:

- tool call sequences
- event **types** and their **ordering**
- filesystem effects

Model output is not deterministic and not a contract. A test that asserts on wording will either be flaky or be silently weakened until it asserts nothing. `ScriptedLLMProvider` exists precisely so agent-loop tests never need to.

## Schema tests — the four assertions (M0-3)

Every event type gets all four. Eleven types × four = the M0-3 gate.

1. A valid fixture **parses**.
2. A malformed fixture **rejects with a useful issue path** — assert the path, not just that it threw. "It failed" doesn't tell a future debugger which field was wrong.
3. The discriminated union **resolves to the right member** for that `type`.
4. **Round-trip identity:** `parse(JSON.parse(JSON.stringify(x)))` deep-equals `x`. This is what catches `Date` and `undefined` fields that don't survive the trip to Postgres `jsonb` and back.

Every event carries `sessionId`, `seq`, `turnId`, `createdAt`.

## The invariants, and who owns them

These are the assertions worth protecting when a deadline tempts you to delete a test.

| Invariant | Owner | Why it matters |
|---|---|---|
| **Append, then publish** — durable write completes *before* fanout | M2-8 | A client that receives an event never persisted sees history that doesn't exist. `PLAN.md` calls this one of the two most valuable tests in the codebase. |
| **Zero commits on a failed turn** | M2-8 | The other most valuable test. A failed turn must leave the workspace at the last good commit. |
| **`seq` monotonic, no gaps, per session** | M2-8, M3-1 | Replay and dedupe both key off `seq`. A gap means a client waits forever; a duplicate means a doubled message. |
| **Replay-then-tail: no duplicates, no gaps** | M3-2 | Called "the correctness heart of the streaming layer". Connect at `seq=5` with 10 events stored → exactly 5 replayed, then live. |
| **Concurrent appends never collide** | M3-1 | Hammer with 100 parallel. The `(session_id, seq)` unique index is the backstop; the test proves the code respects it. |
| **Optimistic message reconciles without duplicating** | M3-7 | Where duplicate-message bugs live. |

Assert ordering with a **recording spy**, not by inspecting final state — "append happened before publish" is invisible once both have finished.

## Conventions

- Ordering assertions go through **`expectEventSequence([...])`**, the helper shipped alongside `InMemoryEventStore` / `InMemoryEventBus`. Use it rather than hand-rolling index comparisons, so failure messages stay readable.
- Fakes live in `packages/*/src/testing/` and are exported. They are production-quality code — treat a bug in a fake as seriously as one in `src/`.
- Tool events come in pairs: `tool.call` then `tool.result`. A failure emits a `tool.result` **marked as error** — it does not throw. An unpaired `tool.call` is a legitimate in-progress state the UI must render (M3-4).
- Writes additionally emit `file.changed` carrying a unified diff (M2-5).
- `run_command` streams `command.output` chunks **in order** (M2-5).

## Determinism

Event tests must be deterministic and free. If it needs the network it belongs in `bun run test:integration`, not the unit suite.

M2-7's gate is that ordering tests pass **10 runs in a row** — if a test only usually passes, it has already failed. Chase the nondeterminism (unawaited promise, real timer, shared mutable fake) rather than re-running until green.
