# ADR-0031 — The turn budget is denominated in what is billed

**Status:** Accepted — 2026-11-09. Amends [ADR-0011](0011-an-old-turns-tool-traffic-is-not-worth-carrying.md)
("the 400,000-token turn budget stays where it is") and narrows the automatic trigger in
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

**The budget is denominated in billed tokens, meaning uncached-input-token equivalents.** Each part
is charged at its weight from one table, `BILLED_WEIGHTS`: a cache read at 0.1, uncached input at
1, a five-minute cache write at 1.25 and output at 5. These are Anthropic's published multipliers
for `claude-opus-5` and `claude-sonnet-5`. `DEFAULT_MAX_TOKENS` becomes 1,000,000 of those, so the
ceiling is the model's input price times a million. The cached turn above spends about half of it
in forty steps. The same turn with its cache missing on every request runs out around step
twenty-one, and one writing 16k tokens a step runs out sooner. NapBench prices cached input through
the same table, so the budget and the estimate cannot disagree about a cache read.

**Automatic compaction answers only to the context's size**: the configured context ceiling, the
model's window, or a session that arrives needing it. What is left of the budget is not a reason
to compact. A turn spending too much is the budget's to stop, and it still does.

## Consequences

- **A run held at the old budget does not compare with one held at the new.** The report records
  `maxTokens`, and NapBench refuses a comparison across different ceilings. It is right to refuse:
  the unit changed as well as the number.
- **The price table's version moved** (`2026-11-09`), because cached usage now prices below the
  input rate. Usage without cache fields prices exactly as before.
- **The weights are one vendor's.** An OpenAI model through OpenRouter does not surcharge a cache
  write, and its output ratio is nearer 6. The budget only needs proportion; the estimate says it is
  one.
- **Codex's native compaction reports no cache split**, so its input is charged as uncached. That
  is the conservative reading, not a measurement.
- **A turn near its budget no longer compacts to stretch it.** It finishes or fails on
  `budget_exceeded`. Compaction made such a turn more expensive, not cheaper.
- **Admission checks price a request as if none of it were cached.** They run before the provider
  has said anything about the request, and an expired cache is the case they exist for.
