# Repair round 1 reproductions and red tests

Completed the approved pre-repair verification queue. GH-LP-002 and GH-LP-003 are supported by real-browser observations. GH-LP-004's stale navigation state and retained content inertness are supported, with a narrower visual consequence than the old static report. All 11 new regression cases fail for behavior-specific reasons on the old production code; 53 native control tests pass. This is red evidence for the fixer, not a readiness verdict or a repaired-candidate result.

## Revision and scope

- Repo/cwd: `<repo>`, branch `feat/landing-redesign`.
- HEAD/base: `13f7fa7f478982ed9316f2348f2ee5f61214bd00`.
- Old production snapshot: `e87520ec5a20a2525cb9abd3c57832b83252b827`, tree `48d4494ecc1d9cde8a16d8b7a0b4d6c21ec1dc07`.
- Initial source manifest matched every file in that snapshot. Final manifests differ only in the fixer's two existing test files; the added landing integration test is also fingerprinted. Production files and index tree remained unchanged.
- Sole verification worker, Codex gpt-6.1-sol high/default. Read run ledger/state/findings, baseline, both prior reviews, God's Hand SKILL/briefs, root/web instructions, relevant GOTCHAS and TypeScript/Unslop instructions.
- No production edits, staging, commits, remote/GitHub writes, other-worktree changes, server lifecycle changes, paid operations, auth mutations, model/sandbox operations, full baseline, lint, build, or standalone typecheck.

Source evidence: `logs/repair1-repro-source-before.json`, and before/after manifests in `logs/repair1-red-tests-results.json` and `logs/repair1-native-controls-results.json`. Each focused check reports `sourceUnchangedDuringCheck: true`.

## Docker availability

Executed `python3 <skill>/scripts/run_check.py --timeout 20 -- docker info` at the repo cwd. Exit 0, approximately 0.81 seconds. Server responds as Docker 29.8.2 on OrbStack, aarch64. Docker was already running; no startup or reconfiguration occurred. This establishes availability only. No DB tests or containers were started.

Full output and argv: `logs/repair1-docker-info.json`.

## Browser method and transport

First called T3 `preview_status`, then created a new background tab with `reuseExistingTab=false`, `profileId=incognito`, `open=false`. Own tab ID: `tab_4_cafbff54-e12a-4b07-87da-a542e872cd70`. No other tab was operated.

T3 evaluation confirmed outer 390×844 and native demo 390×640. Its snapshots failed twice at the same step with the raw error:

> Preview snapshot failed: Preview automation snapshot timed out after 15000ms.

Closed that tab through `t3_preview_close`, then used the repo's documented Chrome workflow through the shared runner. Chrome executable: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; Playwright import: `apps/napbench/node_modules/playwright-core/index.mjs`. Chrome version 153.0.8010.54. Each attempt launched a fresh headless Chrome and isolated nonpersistent context with one page, viewport 390×844 and ordinary motion. Native iframe remained 390×640.

Browser commands were serialized, each through `run_check.py --timeout 90 -- node <run>/logs/repair1-repro-browser.mjs`. Exact scripts are preserved as `repair1-repro-browser-attempt1.mjs`, `repair1-repro-browser-attempt2.mjs`, and `repair1-repro-browser.mjs`. Attempts 1 and 2 exit 1; final remaining-queue attempt exits 0. First attempt used an overly exact native link name; second resolved the link but could not click because its position was below the outer viewport. Both partial results are retained, not reported as completed drawer experiments. The final attempt used a real wheel action in the outer margin to expose the embedded app before native selection.

Injection disclosure: evaluation seeded only synthetic `nap.sidebar.width=320` and `nap.sidebar.collapsed=false` on a same-origin 404 before fresh landing navigation. Other evaluations only observed DOM, state, viewport, or link names. All interactions used real Playwright mouse clicks, keyboard presses, and wheel input. No synthetic focus, click, postMessage, progression, or timer injection. Browser request logs contain no non-GET requests.

T3 evidence: `logs/repair1-t3-preview-evidence.json`. Browser probes and screenshots are indexed by timestamp and step in `logs/repair1-browser-attempt1.json`, `logs/repair1-browser-attempt2.json`, and `logs/repair1-browser-evidence.json`.

## GH-LP-002: supported

Fresh compact landing navigation changed the isolated origin's real product key `nap.sidebar.width` from seeded `320` to `208` before interacting with the story. The native iframe was `/demo/landing?thread=finance&chapter=describe`, inner width 390, and Dashboard's computed inline width was `208px`. The seeded collapsed value stayed `false`.

Observed in both T3 and independent Chrome contexts. This proves a real preference overwrite on mount; no actual user's personal storage was used. The native Dashboard clamp and persistence path matches the previous report. Additional component reds establish saved-collapse leakage, collapse writes, and keyboard resize writes. Those extra actions were not separately browser exercised.

## GH-LP-003: supported

Clicked outer `01 Describe`, then pressed End. Before End, top document active element was `button#chapter-describe`; child active element was BODY. After 800ms, outer chapter was ready, top active element was the demo IFRAME, and child active element was `button#workbench-tab-preview`, Browser. The following real ArrowLeft selected child `workbench-tab-code`, Files, while the outer chapter stayed ready. Outer scrollY remained 1353 throughout this keyboard sequence, so no outer scroll jump was observed.

For the explicit-user comparison, clicked outer Build & check and then the native Show right panel button. Focus moved into the child workbench, onto its previously selected Files tab. This distinguishes intentional app entry from the automatic ready transition.

On a fresh page, scrolled with a real wheel until the story became visible and let normal autoplay reach ready. Before scrolling, top active element was BODY and the child was unfocused. After ready, top active element was IFRAME and child active element was Browser. No child interaction or chapter-message injection occurred.

Screenshots under `evidence/`: `repair1-focus-before-390x844.png`, `repair1-focus-after-390x844.png`, `repair1-focus-explicit-app-390x844.png`, `repair1-focus-autoplay-390x844.png`. Keyboard evidence is in attempt 1/2 JSON; autoplay evidence is in final JSON. These screenshots show the page, while active-element probes supply the focus proof.

## GH-LP-004: supported state defect; visual claim narrowed

Clicked native Open sessions, then native Highland stays, then native Launch tracker. Did not use the outer thread switcher. Active child and parent thread changed finance → cabins → launch. After each selection, Dashboard still had `data-navigation-open="true"`, and its MAIN retained `inert`. After Escape, `data-navigation-open="false"`, MAIN was no longer inert, and the focused control was Open sessions.

Screenshots `repair1-drawer-before-390x844.png`, `repair1-drawer-highland-390x844.png`, and `repair1-drawer-launch-390x844.png` are in `evidence/`. The initial screenshot visibly shows the native drawer. After selecting these ready fixtures, the workbench preview occupies the visible frame despite stale open navigation state. Therefore the old claim that the drawer necessarily visibly covers the ready preview is not established by this browser run. The observable integration failure is retained open navigation state and inert main content after successful local selection. Escape remains a verified workaround.

Same-thread reselection and ancestor-cancelled selection were exercised by component tests, not this browser sequence.

## Distinguishing red tests

User approved this follow-up queue after the fixer's regression-only phase. Both checks ran through `run_check.py --timeout 180 -- python3 <run>/logs/repair1-run-focused.py <name> <command...>`. The helper captures exact child argv, timestamps, full output, exit code and source fingerprints; it does not edit source.

1. `bun run test:fast --project web apps/web/src/landing/landing-desktop-demo.test.tsx`
   - 2026-10-25 19:52:01.025 to 19:52:04.001 UTC, exit 1. Vitest duration 2.61s.
   - Exactly one web file collected, 11 failed tests out of 11. No import error, missing API exception, collection failure, timeout, or unhandled-error failure.
   - GH-LP-002: expected saved width 320, received 208; expected expanded Collapse sidebar control, actual Expand sidebar with aria-expanded=false; expected saved collapsed false, received true; expected saved width 320 after keyboard resize, received 336.
   - GH-LP-003: both describe/build-to-ready cases and already-open-preview case expected Walkthrough chapters to have focus; actual focused node was `#workbench-tab-preview`. Nonmodal semantics assertion comes later and was not reached.
   - GH-LP-004: detail 0, detail 1 and same-thread reselection reach the drawer-closed check and fail because Open sessions is absent while Close sessions remains aria-expanded=true. Selection-current assertions passed before that failure. Cancelled selection fails because the chosen link incorrectly gains aria-current=page.
   - Full output: `logs/repair1-red-tests.log`. Metadata/manifests: `logs/repair1-red-tests-results.json`. Parsed summary: `logs/repair1-red-failure-summary.json`.

2. `bun run test:fast --project web apps/web/src/dashboard/dashboard.test.tsx apps/web/src/dashboard/sidebar-interactions.test.tsx apps/web/src/workspace/workbench.test.tsx`
   - 2026-10-25 19:52:15.631 to 19:52:17.334 UTC, exit 0. Vitest duration 1.47s.
   - Exactly three web files, 53 passed tests. Native persistence, modal focus and existing navigation/cancellation/rename controls pass on old production.
   - Full output: `logs/repair1-native-controls.log`. Metadata/manifests: `logs/repair1-native-controls-results.json`.

The repository test:fast script expands to unit/types/web projects plus the explicit web flag. File filters collected only the named web files. Both logs print the existing experimental type-testing notice and Type Errors no errors. No standalone typecheck, full test suite or broader gate was executed or claimed.

Test SHA-256 values: landing-desktop-demo.test.tsx `78abae353b2e68902d5686cdec79b67c4356ac1c4820b9e976cd7ba25c69792b`; dashboard.test.tsx `2dcae0894cb1bbe80bae738c9080d00094ac10cacf4a2a14bad8c4fc84ec1e55`; workbench.test.tsx `706e3c95479211b76f32beb7ba082acbc7497b7348ef892271f394bbccb1205e`.

## Cleanup and handoff

Own T3 tab is closed. Each isolated browser/context closed in finally; shared runner cleaned each command's process group. Chrome/worker PIDs captured at startup were checked afterward with ps and none remain. Attempt 1 worker/browser 7377/7378; attempt 2 8022/8023; final 8360/8368. Associated startup service process IDs and empty remaining-process rows are in `logs/repair1-cleanup.json`. No tab/context/process is retained for the next phase. Shared port-3000 server and resource.lock were preserved.

GH-LP-001's earlier lint failure is reused, not rerun. GH-LP-005 and the accepted rewind contract were untouched. No production repair has been tested. Stop here and return supported reproductions plus distinguishing reds to the fixer; rerun the approved focused commands and browser triggers only after implementation and a new candidate fingerprint.
