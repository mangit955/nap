# ADR-0016 — Compaction preserves the event log

**Status:** Accepted — 2026-10-19

A long tool loop can exhaust its budget even when its initial context fits. Keep ADR-0011's
cheap staleness pruning and add explicit summary compaction under the existing session lease,
between completed tool batches. Commit the summary, retained complete tool exchange and covered
event boundary together in the append-only log. Rebuild from that boundary after a restart;
never rewrite the transcript. A failed or cancelled summary cannot replace the previous one.

Original user requests stay at user priority, separately from the generated summary, and the
current job brief stays in the assembled context. This costs more than trusting the summary to
remember every instruction, but makes early constraints survive even an incomplete summary.
Generated summaries remain quoted, untrusted conversation data. If the protected context cannot
fit, stop instead of cutting the current request. This supersedes ADR-0011's claim that the old
truncation ladder is the only response to context pressure.

Native providers own their compacted history and persist a different marker containing the
native session identity and covered event boundary. That marker must never suppress history on
an API route. See [the integration and verification notes](../compaction.md) for the native
subscription boundary and the reproducible checks.
