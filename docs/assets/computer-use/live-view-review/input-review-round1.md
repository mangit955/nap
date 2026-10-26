# Computer input UI review

Reviewed commit `51b9c582a3c280774ea3cac7da00eeb938b2c0bb` against its parent `cdee93f`, in `/Users/manasraghuwanshi/.t3/worktrees/nap/t3-1a4861ea`. HEAD matched the requested commit and the worktree was clean before and after review. No source edits, subagents, builds, paid calls, Devin interaction, or full gates were performed.

Read the root/web CLAUDE and AGENTS guidance, relevant Web/UI and Testing GOTCHAS, both new implementations and test suites, CSS, fixture, browser/mutation scripts, integration/evidence docs, and the relevant existing schema, HTTP route, and physical-input adapter. Parent placement, live/busy/connection/sandbox-generation wiring, toolbar, and RimGlow are accepted as supplied in the brief. This does not re-review server lease fencing.

## Findings

### P2: A double click can dispatch three remote clicks

Location: `apps/web/src/computer/computer-input-surface.tsx:229-235`.

The handler interprets every browser `click` with `detail === 2` as a fresh remote double click, even when its first click has already been dispatched. Reproduce while driving: dispatch the first click, wait 450 ms, then deliver the second click with `detail: 2`. This is the relevant sequence when the browser/OS recognizes a double click beyond this component's fixed 400 ms delay. The first timer sends `left_click`; the second event sends `double_click`. The existing adapter implements those as one plus two physical clicks (`packages/sandbox/src/desktop-input.ts:59-64`). Two user clicks therefore become three, potentially activating a control again or changing selection unexpectedly.

This also occurs without waiting for the timer if a key/text event flushes the pending first click before the second click. A related case is double-clicking to acquire control: if the grant arrives between clicks, the swallowed acquisition click is followed by a remote `double_click`, despite there being no pending first remote click.

Evidence: added `/tmp/nap-input-ui-review-tests/surface.test.tsx` assertions against the actual committed component fail with exactly `[left_click, double_click]` for the 450 ms case, and one `double_click` for the takeover case. Dedicated local Chrome/CDP reproduced both outputs in the existing fixture. CDP supplied click counts explicitly; this does not measure the host's configured double-click interval. The shipped test only exercises two clicks before the timer fires.

Fix direction: track whether the first click in a click sequence is pending, already sent, or consumed by takeover. Only replace a still-pending first click with a whole double-click action; do not synthesize two new remote clicks after the first was sent or consumed.

### P2: Accepted large pastes exceed the existing five-second input deadline

Location: `apps/web/src/computer/computer-input-surface.tsx:142-159`, especially the single `sendActions(actions)` at line 159.

Reproduce by pasting 32,000 ASCII characters while driving. The component accepts this advertised size and sends all sixteen 2,000-character chunks in one HTTP batch. The existing route creates one five-second deadline for the entire batch (`apps/api/src/computer/access.ts:136-144`). The actual adapter types with `xdotool type --delay 1` (`packages/sandbox/src/desktop-input.ts:103-107`). The configured character delays alone require about 32 seconds, before command/network overhead. The request times out after applying a prefix, and the hook drops the remaining work and exits driving mode. Splitting text into schema-sized actions has not split the request's time budget.

Evidence: `/tmp/nap-input-ui-review-tests/paste.test.tsx` drives the actual paste handler into the real API composition and `performDesktopAction`. A deterministic host models elapsed time from the actual `--delay` argv and input lengths. It confirms one 16-action request, the 5,000 ms deadline, and HTTP 503 with `applied: 2` when the third chunk exceeds that deadline. This is a timing-model reproduction, not measured X11/E2B throughput; the exact physical prefix is not established. The large mismatch between the configured deadline and typing delay is present in the real code. The shipped paste test uses a transport stub that accepts the batch immediately.

Fix direction: send bounded chunks as separately acknowledged requests while preserving input order and generation cancellation, or reject text that cannot fit the existing request budget before dispatch. Never replay a failed or ambiguous chunk.

## Verification and limits

- The two committed web suites passed: 43 tests. They cover late grants/results, source/session/history/disconnect/busy cancellation, serialization, adjacent move coalescing, partial/failed responses without replay, schema limits, coordinate mapping, whole drag, text, paste, keys, and ordinary IME deduplication.
- Two extra hook probes passed against committed source: 66 submitted key batches overflow the bounded queue with only one input request dispatched and all pending promises settled false; explicit retake after expiry obtains a fresh grant without replaying the old input.
- Automatic grant renewal is absent by design. `INTEGRATION.md` explicitly requires retake after expiry. The hook checks expiry both by timer and before dispatch. No separate renewal defect is claimed under that contract.
- The added surface probes expose the click defects above. An empty composition commit correctly sends no preedit text.
- A synthetic `blur → compositionend → trailing input` sequence forwards canceled IME text at `computer-input-surface.tsx:325-342`. Native Chrome in this review instead committed before blur, so this is an unconfirmed cross-browser/event-order concern, not a third actionable finding. Native mobile keyboards, AltGraph/dead-key layouts, and other browsers were not exercised.
- All seven PNG hashes match `SHA256SUMS`; the driving capture and CSS were inspected. The browser evidence used the already-existing `/tmp/nap-control-review` bundle, whose relevant handlers were inspected, without rebuilding. The source-level assertions above independently run the exact reviewed files.
- T3 preview snapshot failed twice with `Preview automation snapshot timed out after 15000ms.` The documented dedicated local Chrome/CDP workflow was used afterward. Only the local fake-HTTP fixture was driven.
- The mutation script was read, not run, because it edits source. No full suite/typecheck/lint/build or database fencing revalidation was requested or performed.

The component fixture and these checks do not establish full feature completion. Real owner cookies, protected input against a real desktop, view-only streaming, final parent integration/visual behavior, and cloud verification remain outside this review. No missing-parent-integration finding is made.

Additional test files and the local CDP probe are retained in `/tmp/nap-input-ui-review-tests`. Re-run the passing supplemental probes with `cd /private/tmp/nap-input-ui-review-tests && ./node_modules/.bin/vitest run --config vitest.config.mts hook.test.tsx paste.test.tsx`. The surface file intentionally contains failing bug assertions and the unconfirmed synthetic IME assertion.
