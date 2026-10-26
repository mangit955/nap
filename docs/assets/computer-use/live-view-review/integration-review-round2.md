# Computer UI repair review

Reviewed the ROOT working tree at `/Users/manasraghuwanshi/.t3/worktrees/nap/feat-computer-use`, HEAD `e8f971b3497818c2867611443ef710d222e9ac5b`, on 2026-10-24. Scope includes the committed input repairs and current uncommitted parent UI repairs and their immediate integration. Production files were read only. The only authored artifact is this report.

## Verdict

No actionable findings in this bounded repair review. The two original input P2s, parent busy-state P2, and keyboard/alignment P3s are repaired. No adjacent regression was found in the reviewed wiring, glow placement, or recordings launcher. This verdict clears these repairs for the parent's next validation step; it does not establish whole-feature or merge readiness.

## Repair verification

- **Click count:** `apps/web/src/computer/computer-input-surface.tsx:231` replaces only a pending first click with `double_click`. Reproductions covered by the passing tests include first-click timeout, a key or text flushing the first click, and a grant arriving between acquisition clicks. These now yield two single remote clicks, or only the remaining single click after acquisition. An ordinary pending pair still yields one double-click action.
- **Paste deadlines and ordering:** `apps/web/src/computer/computer-input-surface.tsx:161` synchronously enqueues each bounded text chunk through the existing hook. The 32,000-character reproduction sends sixteen separately acknowledged requests. The focused test runs the real component, hook, API route and desktop adapter, deriving simulated typing time from the adapter's actual argv. Each chunk receives its own 5,000 ms budget; later Enter and right-click remain behind the entire paste. Failure, source replacement and grant expiry discard unsent work without replay. This is a timing model, not measured X11 throughput.
- **Canonical activity:** `apps/web/src/chat/use-turn-submission.ts:393` exposes the existing observation; `apps/web/src/components/chat-pane.tsx:372` reports it; `apps/web/src/components/app-shell.tsx:236` derives and passes Computer busy state. `apps/web/src/computer/computer-activity.ts:16` rejects another session's observation, filters history to the current session, and applies the shared idle prefix. The legacy unfinished-turn reproduction becomes idle after the server covers its cursor. A new `test.started` followed by `turn.completed` remains busy until `test.completed` or an authoritative idle prefix covers it, through the pending-test check at line 20. The helper adds no subscription or polling loop. The chat remains mounted when hidden by the Computer pane, so reporting continues.
- **Keyboard propagation:** `apps/web/src/computer/computer-input-surface.tsx:296` stops driving keys; line 297 also stops Shift+Escape while idle. Passing tests cover both states. Release no longer reaches the Workbench Escape handler through this path.
- **Coordinate alignment:** `apps/web/src/app/globals.css:2709` sets the input overlay to `inset: 0`, matching the live viewport. The supplied browser check computes the effective centered 1024×768 input rectangle before comparing it with noVNC's canvas, rather than incorrectly requiring the full letterbox container to equal the canvas.
- **Driving glow:** `apps/web/src/computer/computer-pane.tsx:142` mounts the glow before the opaque live frame. I inspected the saved driving PNG, the actual layering, and the browser check. The red log records a framebuffer-interior mismatch; the final browser log passes after the change. The screenshot shows no interior cones. The automated guard samples an 8×8 interior region during an active pulse, not every framebuffer pixel.
- **Recordings launcher:** `apps/web/src/components/app-shell.tsx:301` provides the thread-details entry, selecting the latest completed available recording or opening the empty viewer. The passing shell tests exercise empty-state open/close and the existing card-to-owner-recording URL/download path. Session identity scopes the open viewer; close unmounts it. The launcher adds no data request.

## Checks performed

Read root/web CLAUDE and AGENTS guidance, relevant GOTCHAS, both supplied prior reports, `take-control-review/REPAIRS.md`, the repaired implementations/callers/tests, and the supplied mutation, red/green and browser evidence. The mutation log preserves the intermediate runner matching errors and later records all 13 guards as observed failing. I did not rerun mutations in the active parent checkout.

Ran this focused command against the current source:

```sh
bunx vitest run --maxWorkers=2 \
  apps/web/src/computer/computer-input-surface.test.tsx \
  apps/web/src/computer/use-computer-control.test.tsx \
  apps/web/src/computer/computer-activity.test.ts \
  apps/web/src/computer/computer-pane.test.tsx \
  apps/web/src/components/app-shell.test.tsx \
  apps/web/src/components/live-chat-pane.test.tsx \
  apps/web/src/chat/use-turn-submission.test.tsx
```

Result: **7 files, 128 tests passed**, exit 0, 6.45 seconds. Vitest reported no type errors; this was not a standalone full typecheck.

The input test uses canonical `@nap/sandbox` imports, and the web manifest declares the test API/sandbox dependencies. I found no new runtime-to-bench edge in the reviewed recording files.

## Limits

No source edits, paid calls, builds, Devin interaction, subagents, full gates, database fencing revalidation, or new browser run. Existing LiveDesktopFrame and recording-player lifecycle verdicts were not reopened beyond the changed integration. The supplied browser evidence is local raw RFB, fake owner HTTP and local recording storage, with `cloud: false`; it does not prove real owner cookies, E2B input throughput, or cloud recording/takeover behavior. Native OS double-click thresholds, mobile/IME behavior across browsers, and a complete live AppShell activity-to-control browser scenario were not independently exercised here. Shared activity is supported by the helper tests, LiveChatPane callback test, and direct wiring inspection.

True E2B validation and matching recording/takeover references remain pending as stated by the parent. Their absence is a coverage limit, not a new finding. The parent's full-run result remains outside this review.
