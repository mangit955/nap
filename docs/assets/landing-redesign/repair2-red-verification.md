# Repair round 2 distinguishing red evidence

The six new regression cases fail for the expected cache and scroll-storage reasons on round 1 production. The native default scroll control passes. Real Chrome separately reproduces stale Finance code after selecting ready Cabins and confirms all four outer font exceptions at both requested mobile sizes. Return these results to the fixer before any production edit. No round 2 repair is implemented or verified here.

## Exact scope

Repo/cwd `<repo>`, branch `feat/landing-redesign`. HEAD/base `13f7fa7f478982ed9316f2348f2ee5f61214bd00`. Production/index remain round 1 snapshot `b48b0f4c2af74d4b6997c6cb27b7600c85eb4412`, tree `d17ef4b8e94e0efdb241129669200b8e27db093a`.

Read `review-complete-initial.md` and `repair2-tests-ready.md`. The tests are the explicit four-file unstaged overlay, not part of the immutable round 1 snapshot. Exact patch is `logs/repair2-test-overlay.patch`, SHA-256 `e52f50bf49c26f5f1892437b7cc78481dd2d234f36a6aa2b65b2c2710acb404c`. Both test commands captured complete source fingerprints and report `sourceUnchangedDuringCheck=true`; production/index did not change. No worker source edits, staging, commits, GitHub writes, additional task, broad gate or paid operation occurred.

## GH-LP-007 browser cache reproduction: supported

Final missing-probe command used established Chrome fallback through `run_check.py --timeout 240 -- node <run>/logs/repair1-candidate-browser.mjs`, with one isolated context/page. This invocation skipped all already completed round 1 triggers and all whole-page manual scripts. It completed in about five seconds, with the cache scenario bounded to 30 seconds and observed in 2,908ms.

At 1440×900, clicked outer Come back, native Files, then the App.tsx row scoped to `#workbench-code`. The actual Pierre renderer stayed in place. An observational recursive reader followed child nodes and open shadow roots, excluding style/script text. Before switching, it positively read `SpendingChart` from Finance's rendered code and found one open shadow root. Thus an observer timeout or missing text is not being used as cache evidence.

Clicked the outer Bookings thread control, waited until the child active thread became `cabins`, then allowed a further second to settle. The visible file pane still contained Finance's `SpendingChart`, lacked Cabins' `nights`, and had exactly the same observed text hash before/after: `7b674db954fcaec1a0fe326422f46b28edbfbb28897be05d0f090f676557bc15`. Finance and Cabins preview iframe DOM instances both remained connected and identical. Screenshot `evidence/repair1-verified-cache-cabins.png` shows Highland stays active beside the stale Finance source. This establishes the source-inspection defect while preserving preview identity. Launch was covered by the component regression, not an additional browser cache switch.

Raw text, source/viewport, timing and identity probes are in `logs/repair1-candidate-browser-results.json`; the exact final script remains beside it. Earlier strict-mode locator ambiguity is preserved separately in `repair1-candidate-browser-attempt2.json` and is not cache proof.

## GH-LP-006 / R-CI-02 computed fonts: supported

On fresh ordinary-motion pages at both 390×844 and 320×667, all selectors matched nonempty text and returned these computed sizes:

- `.nf-heading-aside p`: 14px, required at least 16px.
- `.lp-proof-grid p`: 15px for all three descriptions, required at least 16px.
- `.lp-hero-copy .lp-eyebrow`: 10px, required at least 12px.
- `.ps-demo-caption`: 11px, required at least 12px.

The observations record text, actual font sizes and element scroll/client widths in the same browser JSON. These are outer-page exceptions, not native embedded app typography. No CSS was changed. Full manual check-landing, check-features and reduced-motion coverage remain deferred until final round 2 production; the intentionally stricter new typography guard was not executed as a whole-page check.

## Focused component reds

Exact child command:

```sh
bun run test:fast --project web apps/web/src/landing/landing-desktop-demo.test.tsx apps/web/src/landing/session-preview.test.tsx --testNamePattern 'ready demo file identity|saved session-list scroll|saved scroll'
```

Ran serially through `run_check.py --timeout 120 -- python3 <run>/logs/repair2-run-focused.py red-tests 120 <command...>`. UTC 2026-10-25 20:08:48.329 to 20:08:52.327, exit 1. Two web files collected, six selected cases failed, 15 unrelated cases skipped. Vitest duration 3.68s.

- Both actual ready-thread cache cases first read Finance successfully, activate Cabins/Launch, and pass their retained-preview DOM/contentWindow identity assertions. They fail the final exact-source equality at `landing-desktop-demo.test.tsx:196`, with actual Finance `SpendingChart` source instead of the target booking/launch source. The waitFor reports a source assertion mismatch after settling, not a missing button/region, import, renderer or browser-API error.
- The real demo Sidebar and hero Sidebar read cases both fail because the call-through Storage spy observes `getItem('nap.sidebar.scroll')`.
- Their separate write cases both exercise local list scroll to 120 and fail because `setItem('nap.sidebar.scroll', '120')` occurs over seeded native value 640. No fake storage return or mirrored cache algorithm was used.

I inspected the tests: the actual LandingDesktopDemo, FilePanel/useFileContent cache, fixtures, fetch adapter and parsing run. Only the asynchronous syntax-renderer seam is replaced with `<pre>` by `next/dynamic` in jsdom. The browser reproduction above uses the real renderer without that replacement. The tests require different sessions, distinct source and equal ready event-type sequences; they do not copy the private staleness algorithm.

Full output `logs/repair2-red-tests.log`; runner argv/timestamps/source manifests `logs/repair2-red-tests-results.json`; extracted per-case diagnostics `logs/repair2-red-failure-summary.json`.

## Native default control

```sh
bun run test:fast --project web apps/web/src/dashboard/sidebar.test.tsx --testNamePattern 'stores and restores session-list scroll across native mounts by default'
```

Ran through the same shared runner with timeout 120 and helper name `native-control`. UTC 20:09:01.706 to 20:09:02.632, exit 0. One selected test passed, 16 unrelated cases skipped; Vitest duration 674ms. It uses default Sidebar behavior, restores 640, stores local scroll 120 and restores 120 on a fresh mount. Full output `logs/repair2-native-control.log`; exact argv and fingerprints `logs/repair2-native-control-results.json`.

The test:fast script's experimental type-testing notice and `Type Errors no errors` are retained verbatim; no standalone typecheck or broader suite pass is inferred.

## Cleanup and stop

Final probe worker/browser 12600/12621 and startup child PIDs 12627, 12628, 12629, 12630 are no longer present. Context/browser closed in finally; runner cleaned process groups. Earlier partial probe contexts also closed. Exact ownership/empty ps rows are in `logs/repair1-and-repair2-cleanup.json`. No tab or process is retained, shared 3000/resource.lock remain untouched, and no shell/browser jobs remain active.

Round 1 green evidence is in `reports/repair1-verification.md`; pinned base screenshots/recording are in `reports/before-visual-evidence.md`. Do not merge these revision scopes. No more probes or checks are queued by this worker now. Fixer implementation, a new stable candidate, green round 2 regressions, final broad gates and final browser/visual evidence await root authorization.
