---
name: nap-events
description: Use when writing or testing anything that emits, stores, orders, replays or renders Nap events — event schemas, sandbox-proxy tools, AgentService, Runtime, EventStore, EventBus, the WebSocket endpoint, or the chat pane. Applies to tasks M0-3, M2-5, M2-7, M2-8, M3-1, M3-2, M3-3, M3-4 and M3-7. Triggers on "event", "seq", "turn.started", "tool.call", "replay", "event ordering", "expectEventSequence", "append", "publish".
---

# Testing Nap's event system

`events` is the most load-bearing table in the system: chat transcript, agent audit log, WebSocket replay source, and v2's memory substrate — all one table (`docs/PLAN.md` §5). Bugs here are silent and corrupt history rather than crashing.

The shapes live in **`packages/shared/src/events.ts`** (M0-3) — one Zod discriminated union on `type`. Import from it; never hand-write an event literal's type alongside it.

## The 11 event types

Every event is `{ type, sessionId, turnId, seq, createdAt, payload }` — the envelope mirrors the `events` row in `docs/PLAN.md` §5 one-to-one, so `EventStore` append/read is a straight mapping. `seq` is assigned by `EventStore.append`, not by the emitter.

| `type` | `payload` | Emitted by |
|---|---|---|
| `user.message` | `{ text }` | M3-7 |
| `agent.thinking` | `{ text }` — summarized thinking | M2-7 |
| `agent.message` | `{ text }` | M2-7 |
| `tool.call` | `{ toolCallId, toolName, input }` | M2-5 |
| `tool.result` | `{ toolCallId, toolName, ok, output }` | M2-5 |
| `file.changed` | `{ path, changeType, diff }` | M2-5 |
| `command.output` | `{ toolCallId, stream, chunk }` | M2-5 |
| `preview.ready` | `{ url, port }` | M1-4 |
| `turn.started` | `{}` | M2-7 |
| `turn.completed` | `{ usage: { inputTokens, outputTokens }, durationMs, commitSha }` | M2-8 |
| `turn.failed` | `{ reason, message }` | M2-6, M2-7, M2-8 |

Closed sets, all exported from the same module: `toolName` is one of the six M2-5 tools (`TOOL_NAMES`); `changeType` is `created \| modified \| deleted`; `stream` is `stdout \| stderr`; `reason` is `refusal \| budget_exceeded \| cancelled \| sandbox_unavailable \| internal` (`TurnFailureReasonSchema`). Adding a value is a deliberate schema change — that is the point.

**Two rules when you extend this, both about surviving Postgres `jsonb`:** no `Date` and no `undefined` (timestamps are ISO-8601 strings, absent values are `null`), and payloads are `strictObject` so an unknown key is rejected rather than silently dropped on the way into the log. Both are proven by the M0-3 tests — see below.

## The one rule that governs everything here

**Never assert on model prose.** Assert on:

- tool call sequences
- event **types** and their **ordering**
- filesystem effects

Model output is not deterministic and not a contract. A test that asserts on wording will either be flaky or be silently weakened until it asserts nothing. `ScriptedLLMProvider` exists precisely so agent-loop tests never need to.

## Schema tests — the four assertions (M0-3)

Every event type gets all four. Eleven types × four = the M0-3 gate, met in `packages/shared/src/events.test.ts` by a single `CASES` table driving four `describe.each` blocks — add a type to the union and its case is required, so the count stays structural.

1. A valid fixture **parses**.
2. A malformed fixture **rejects with a useful issue path** — assert the path, not just that it threw. "It failed" doesn't tell a future debugger which field was wrong.
3. The discriminated union **resolves to the right member** for that `type`, *and* rejects that type paired with a structurally foreign payload. Pick the foreign payload deliberately: `user.message`, `agent.thinking` and `agent.message` all carry `{ text }` and are interchangeable at the payload level by design.
4. **Round-trip identity:** `parse(JSON.parse(JSON.stringify(x)))` deep-equals `x`. Use `toStrictEqual`, not `toEqual` — `toEqual` treats a dropped `undefined` key as equal to a present one, which is the exact `jsonb` bug this assertion exists to catch. It also catches `Date` fields: swapping `createdAt` to `z.coerce.date()` fails all 11 round-trip assertions, which is how this was verified.

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
