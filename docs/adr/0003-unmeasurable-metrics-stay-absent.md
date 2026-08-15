# ADR-0003 — Metrics the event log cannot supply stay absent

**Status:** Accepted — 2026-08-14

## Context

NapBench derives a run's trajectory from the existing event stream. That is deliberate: Nap already
has a structured, durable, ordered record of everything a turn did, and a second parallel
instrumentation path would be a source of truth that can disagree with the first.

Most of what a trajectory wants is already there. Tool calls are `tool.call`. Tool failures are
`tool.result` with `ok: false`. Commands are `tool.call` where the tool is `run_command`. Files
touched are `file.changed`. The turn lifecycle is `turn.started` and its one terminal event.
Cancellations, model outages and sandbox failures are all `turn.failed.reason`. Token usage is
`turn.completed.payload.usage`.

Three things are not there, and checking the schema rather than assuming was the point:

**Agent steps.** A turn is several model calls — the model asks for a tool, gets an answer, asks
again — and nothing in `NapEventSchema` marks the boundary. The loop is invisible in the log.

**Retries and recovery attempts.** `ClaudeProvider` retries inside itself and emits nothing. A turn
that succeeded on the third attempt is indistinguishable in the log from one that succeeded first
time.

**Tokens on a failed turn.** `turn.completed` carries `usage`; `turn.failed` carries only a reason
and a message. A run that crashed has no token count at all, which is exactly the run where cost is
most worth knowing.

## Decision

`agentSteps`, `retries` and failed-turn token usage are typed **optional and left absent**. The
report omits them; the CLI summary prints nothing rather than a zero. `docs/NAPBENCH.md` records why
and what would make each available.

Estimated cost is **derived**, from a versioned per-model price table held in `@nap/bench`, and
labelled in the report as an estimate rather than a measurement. It is absent whenever the token
counts it depends on are absent.

No new event is added to `NapEventSchema` to serve evaluation.

## Why not just add the event

`agent.step` would be a small, tidy change and it is tempting. It is refused for three reasons that
compound.

The event contract is the most load-bearing thing in the repository — chat transcript, agent audit
log, WebSocket replay source, and the substrate a later memory system is meant to be built on, all
one table. Adding a member touches the union, the WebSocket protocol, the chat pane's exhaustive
switch, and every test that asserts on an event sequence.

Events are durable. An event type added this week is in the `events` table forever, and every
consumer written afterwards has to handle it. That is a permanent product commitment, and the
justification for it here would be a measurement.

It is the exact thing the design was told not to do: evaluation concerns must not leak into
production code. A change to the production event contract made because the benchmark wanted a
number is that leak, whatever it looks like from inside the diff.

None of this says `agent.step` is a bad event. It might well be a good one — per-step visibility
would be genuinely useful for debugging a turn that stalls, and if that case is ever made on its own
merits the event should be added. The claim is only that NapBench is not the argument for it.

## Consequences

NapBench cannot answer "how many model calls did this task take", which is one of the more
interesting things to compare between models — a model that reaches the same result in four steps
rather than eleven is meaningfully better and the score will not show it. This is a known,
documented limitation rather than a gap to be quietly filled.

A model that fails often will have gaps in its token accounting, so cost comparisons across models
with different failure rates are understated for the less reliable one. Reported alongside
`errorRate`, per ADR-0002, so the gap is at least visible.

**The seam is additive.** Because these fields are already typed as optional on the metrics model,
the day an `agent.step` event exists for its own reasons, NapBench reads it and starts populating
`agentSteps` with no change to its result model, its report schema, or any historical report. Old
reports remain valid; they simply lack the field.

## Alternatives considered

**Infer agent steps heuristically** — count contiguous runs of `agent.thinking` / `agent.message` /
`tool.call` before the next `tool.result`. Cheap and approximately right. Rejected because it is an
inference presented in the same shape as a measurement, and it is specifically wrong when a model
issues several tool calls in one batch. The repo already knows that case exists and is
under-exercised, which makes a metric that silently miscounts it a bad thing to introduce into the
one artefact whose job is to be trusted.

**Read usage from the `LLMTurn` handle instead of the log.** `LLMProvider.startTurn` returns a
handle with a `usage()` method, and NapBench composes the provider itself, so it could hold that
handle and read totals even on a failed turn. Rejected for this cut because it makes NapBench
depend on a detail of how the `Runtime` uses the provider rather than on what the run recorded, and
the whole trajectory story is "consume the existing event stream". Worth revisiting on its own if
failed-turn cost becomes the thing that matters.
