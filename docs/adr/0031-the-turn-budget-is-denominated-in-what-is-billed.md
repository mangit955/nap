# ADR-0031 — The turn budget is denominated in what is billed

**Status:** Accepted — 2026-11-09. Amends [ADR-0011](0011-an-old-turns-tool-traffic-is-not-worth-carrying.md)
("the 400,000-token turn budget stays where it is") and
[ADR-0030](0030-fusion-the-sidekick-condenses-and-the-lead-acts.md) D5 ("`TurnBudget` counts
tokens, not money"), and narrows the automatic trigger in
[ADR-0016](0016-compaction-preserves-the-event-log.md).

## Context

`TokenUsage` carried two numbers. The provider folded uncached input, cache writes and cache reads
into `inputTokens`, and `TurnBudget` added `inputTokens + outputTokens` against 400,000. A turn
re-sends its whole conversation on every round trip, and from the second one on most of it is a
cache read billed at a tenth of the input price. So the budget charged ten times what was billed for
most of what it counted.

The effect was that the step limit could not be reached. A turn that re-reads a 30k-token context
from the cache, grows it by a step's result each time and writes a little per step ran out of
budget at its eleventh step (`budget.test.ts` reproduces it) of forty. Before that, the loop's
context check treated budget accounting as context pressure: a context of 24k or more, re-sent
three more times, costing more than half of what remained, was compacted. For that turn it fired
around the seventh step. Compaction is a blocking, uncached summary on the turn's own model, and it
leaves the cache cold. It made the turn slower and more expensive, to save reads that were already
cheap.

ADR-0011 named this as the separate change to make *after* stopping the context from growing,
since raising the effective ceiling first would only have hidden that growth. Staleness pruning
(ADR-0011) and the never-rewritten prefix (ADR-0024) were that first move.

## Decision

**Usage keeps the split the provider reports.** `inputTokens` stays the whole prompt, cached or not,
which is what every report and event already recorded and what the context meter shows.
`cacheWriteTokens` and `cacheReadTokens` are optional parts of it. Absent means none, so an old
event reads as it always did. `@nap/shared/usage` is the only place usage is built, added or priced.

**The budget is denominated in billed tokens, meaning uncached-input-token equivalents of the model
that did the work.** Each part is charged at its weight from one per-model table,
`MODEL_BILLED_WEIGHTS` in `@nap/shared/usage`, read from each vendor's pricing page on 2026-11-09.
The cache multipliers are the same at both vendors: a cache read at 0.1, uncached input at 1, a
five-minute cache write at 1.25 (OpenAI's `gpt-5.6-luna` and `gpt-5.6-terra` pages say "Cache writes
are billed at 1.25x the uncached input token rate"; Anthropic's five-minute write is 1.25x). Only
output differs: 5 for `anthropic/claude-opus-5` ($5/$25) and 6 for the two OpenAI models ($0.20/$1.20
and $2/$12). A model the table does not know is charged `FALLBACK_BILLED_WEIGHTS`, the largest known
weight of each kind, so an unpriced model can only be stopped early, never late.

**The weights are provider policy.** The provider resolves which model a turn runs on, so it hands
the turn its row as `LLMTurn.billedWeights`, beside `contextWindowTokens`. `AgentService` and the
helper pool charge each request at the weights of the turn that made it — the lead's, a fallback's
after a refusal, a helper's on a cheaper model, the sidekick's — and name no model themselves. The
one exception is admitting a sidekick whose conversation is not open yet: its attempt is priced at
the fallback, because opening a conversation the turn cannot afford is what that check avoids.

`DEFAULT_MAX_TOKENS` becomes 1,000,000 billed tokens, so the ceiling is the model's input price times
a million. The cached turn above spends about half of it in forty steps on either vendor. The same
turn with its cache missing on every request runs out around step twenty, and one writing 16k tokens
a step runs out sooner. NapBench prices cached input by the model's own row, and a test holds the
price table and the weight table to the same models and the same output ratio, so the budget and the
estimate cannot disagree.

**Every provider keeps the split it reports.** The Messages API reports cache reads and writes
beside uncached input; Codex reports `cachedInputTokens` and `cacheWriteInputTokens` *inside*
`inputTokens`, on both its cumulative `total` and its `last` response, and `codex exec --json`
reports `cached_input_tokens` inside `input_tokens`. Each is mapped to the same shape, the cached
parts clamped so they never exceed the input they belong to. Codex's cumulative totals are
differenced field by field; a field that goes backwards is a reset, and the reported last response
stands in for it.

**Automatic compaction answers only to the context's size**: the configured context ceiling, the
model's window, or a session that arrives needing it. What is left of the budget is not a reason
to compact. A turn spending too much is the budget's to stop, and it still does.

## Consequences

- **A run held at the old budget does not compare with one held at the new.** The report records
  `maxTokens`, and NapBench refuses a comparison across different ceilings. It is right to refuse:
  the unit changed as well as the number.
- **The price table's version moved** (`2026-11-09`), because cached usage now prices below the
  input rate. Usage without cache fields prices exactly as before. Moving cache pricing to per-model
  rows did not move it again: every row has the multipliers the single table had.
- **The weights are copied from pricing pages, not read off a bill.** A vendor repricing output or
  the cache needs this table changed, and the agreement test only catches the output ratio drifting
  from the price table, not either drifting from the vendor.
- **The local Codex route bills a subscription, not tokens.** `gpt-5.6-sol` has no row, so its turns
  are charged at the fallback; the bound still holds, and it is conservative.
- **Old strict readers cannot parse the cache fields.** Old rows parse in new readers, not the other
  way round. An open browser tab from before this change is served by projection: the API leaves the
  cache fields off every usage it sends unless the socket asked for them with `usageCacheSplit=1`,
  which the new web client does, on replay, reconnect and live frames alike. The set of events that
  carry usage is a compile-time record, so an event that gains usage cannot be forgotten by it.
  Backend readers have no projection: the API and the reaper must run this release before any worker
  writes a cache field (`docs/DEPLOY.md`, "Usage cache split rollout").
- **A turn near its budget no longer compacts to stretch it.** It finishes or fails on
  `budget_exceeded`. Compaction made such a turn more expensive, not cheaper.
- **Admission checks price a request as if none of it were cached.** They run before the provider
  has said anything about the request, and an expired cache is the case they exist for. They price
  that input at 1, not at the 1.25 a cold cache write costs, so a request that writes its whole
  prompt to the cache can cost a quarter more input than it was admitted for. The check after each
  response still records what it actually cost and stops the turn at the ceiling, so the bound
  holds, one request late at most.
