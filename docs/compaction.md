# Compaction integration and verification

Nap supports `/compact` and the Context control on its existing Anthropic API and OpenRouter
routes. Automatic compaction runs in the active model/tool loop as well as at the start of a
turn. It uses the configured input budget, provider window when supplied, response headroom,
reported input with estimated growth, and remaining turn spending. T3's Claude prompt-cache
expiry rules are not used for these routes.

The implementation follows [T3 Code at the pinned revision](https://github.com/pingdotgg/t3code/tree/e3b35d1b2440b104f0bc2e357377c348121234dd).
Source attribution and the MIT license are in [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md).
T3 delegates summary storage to its native providers. Nap's API summary, checkpoint and replay
logic is additional work because those providers are not present on the current routes.

## Persistence and safety

`compaction.completed` stores an API checkpoint with `coveredThrough`, summary and a complete
recent tool exchange. Context assembly keeps original user requests, quotes the summary at user
priority, restores the retained exchange once, then replays events strictly after that boundary.
The current request and job brief remain available. Cheap old-tool pruning still runs. A context
that cannot fit without removing protected instructions fails before the next model call.

The runtime drains tool events before reading the summary source. It validates the replacement
before appending the completed event, then drains that event before continuing. The existing
runtime session queue and durable worker lease serialize compaction with ordinary prompts. An
accepted prompt behind compaction uses the same durable queue. Manual compaction creates neither
a user prompt nor a job/commit. Empty conversations and active leases reject manual compaction.

Summaries are bounded, tool-free calls through the same provider handle, model and credentials.
Their steps and cache-inclusive tokens count against the ongoing turn. Refusal, truncated or
empty output, failed calls and cancellation retain the old checkpoint. Cancellation cannot let a
late summary replace it. An interrupted native operation requires native session recovery.
There is no token refund. The UI distinguishes estimates from provider reports; missing native
usage is null, never a fabricated saving; the turn's aggregate carries `usageIncomplete` when
native spend was not reported. A failed or unknown-cost native operation consumes a
conservative budget reserve internally, which is not presented as measured usage.

Preserving original user requests means an extremely long instruction history can itself fill
the budget. Compaction then stops safely. Images remain in the original transcript; summaries
carry textual references, not encoded image bytes. Summary quality still depends on the model.

## Native subscription integration boundary

`LLMTurn.compact` is an explicit capability. It is never enabled by recognizing a Claude or
Codex model name. Current API/OpenRouter providers do not expose it and continue using API
summaries. `NativeSessionLifecycle.bind()` shares one serialization gate between ordinary model
calls and compaction and refuses to reuse an uncertain native session after failure.

The reusable native adapters implement these protocol operations:

- Codex calls `thread/compact/start` with the current native thread ID. It requires the matching
  context-compaction item and successful turn completion, ignores other threads, interrupts on
  cancellation, and reinjects application context through `thread/inject_items`. Trusted
  instructions use the developer role; quoted conversation/tool context uses the user role.
  Matching token-usage notifications contribute cumulative deltas, with duplicate reports ignored
  and cached input already included. Missing usage or post-compaction size remains unknown.
- Claude sends `/compact` through an existing Agent SDK query session. It requires both
  `compact_boundary` and a successful result for that session. It records reported boundary
  sizes and cache-inclusive usage when supplied, and interrupts on cancellation.

These adapters have transport/lifecycle tests and are exercised through the runtime capability
path. They do not launch CLIs, authenticate subscriptions, or configure SDK tools. The later
subscription provider must supply an authenticated, sandbox-bound transport, share its lifecycle
across turns, preserve the configured Claude system instructions, restore additional application
context on resume, and implement ordinary native turns. It must persist/resume the native session
ID and its delivery cursor against the native completion marker's `coveredThrough` boundary.
A session-backed `complete()` owns that cursor: the supplied conversation is source context, not
permission to resend already delivered or summarized exchanges. Native post-compaction telemetry
calibrates the active loop when supplied; absent telemetry remains conservative.

Native history is never masqueraded as an API checkpoint. Switching back to an API route rebuilds
from portable events and the last API checkpoint. Full native end-to-end behavior cannot be run
until that subscription provider exists. No Anthropic beta API compaction blocks are enabled or
dropped into ordinary text replay by this change.

## Reproduce verification

Run `bun run test` and `bun run typecheck` from the repository root. The suites cover checkpoint
boundaries, early constraints even when omitted by a summary, complete tool pairs, compaction
inside a tool loop, cumulative spending, failed/truncated summaries, cancellation and late
completion, restart replay, native capability handling and queue serialization.

For a free browser check, run:

```sh
bun apps/api/scripts/compaction-preview.ts
```

Open `http://localhost:3035/compaction-check` using the T3 preview browser. The script runs the
real API routes, queue, worker, runtime and WebSocket with in-memory storage and a scripted model.
It creates a temporary Next route and removes it on Ctrl-C; this fixture is not a shipped route.

1. Open Context, click Compact context, and submit a message while it runs. Confirm that the
   status completes before the queued message appears and that the message is answered once.
2. Send `/compact` directly. Select Fail for the next summary and confirm the previous conversation
   remains available, with a failed status and no successful replacement.
3. Select Wait for cancellation, start compaction, then Stop. Confirm the cancelled status and
   submit another normal message successfully.
4. Reload to replay the transcript. Repeat at a narrow viewport and check the Context popup and
   composer remain reachable.

The automated and browser checks use scripted model responses. They verify behavior, not model
summary quality, subscription connectivity or real token savings. No compaction benchmark saving
is claimed. ADR-0011's old pruning reconstruction is a separate measurement.
