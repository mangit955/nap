# Sidebar review evidence

These are unmodified exact-base V006 and clean final V007 captures for PR #132. They replace earlier captures in the PR presentation. Existing files one directory above remain historical artifacts; their filenames do not establish exact-base provenance. `t3-reference-illustration.png` remains an illustration.

## Capture provenance

- Base: `793b0ec717d37b2fa3f3c4137a2cb087b19f286d`, tree `6a7c6888c032253da7ef09e833bf29349d89241f`.
- Final, CAPTURED revision: `ac1dd34f881bcc481ed089e89e5490a63e6e5115`, tree `ac08f681f9ecff88d8e88dac284b913e9cfad86b`. These bytes were not captured at a later publication commit. Reuse after the approved test-variable rename requires confirming that production files are unchanged; later validation must identify its own SHA/tree.
- Chrome 153.0.8010.54, isolated Next 16.3.0 production builds, dark, en-US, UTC, scale 1. Desktop 1100x800; narrow 375x800 with mobile/touch emulation. Actual sidebar/drawer widths are 256/260px. Narrow WebMs encode at 374x800.
- Same 19 synthetic sessions and one draft; fixture SHA-256 `7fbaeade89f2eebe9e14096903f4db195fc3e44e890fbd33aef6efb79ee10443`; display clock `2026-10-23T05:00:00.000Z`.
- Production frontend components and real IndexedDB draft schema, with synthetic auth/API/WS. Dummy endpoints are `http://nap-verification.invalid` and `ws://nap-verification.invalid`. No private account, user DB, model or sandbox was contacted.

[Recorded scenarios, commands, output excerpts and per-asset hashes](evidence.json) retain the tested revisions. The evidence JSON omits private machine paths, process inventories and request logs; it is a curated extract, not the full execution log. Source-log hashes identify the retained originals. No command was rerun to write this document.

## Media

- Exact-base initial layout: [desktop](base-desktop.png), [narrow](base-narrow.png); recordings [desktop, 10.00s](base-desktop.webm), [narrow, 3.72s](base-narrow.webm).
- Final initial layout: [desktop](final-desktop.png), [narrow](final-narrow.png); recordings [desktop, 9.08s](final-desktop.webm), [narrow, 6.32s](final-narrow.webm).
- Final [Escape retains session-link focus](final-escape-focus.png). The narrow recording continues through ArrowDown, an unhandled Escape that closes the drawer, forward/reverse Tab and touch dismissal/reopening.

The base collapses Done after reload, has no shelf pagination or draft row, and restores archives through its sidebar filter. Final preserves shelf expansion, pages Settled from 10 to 12 fixture rows, resumes the draft from a row without submitting, and restores through Settings. Pagination count itself does not persist. Both versions keep the selected task visible in this fixture. Final bounds are y=632..668 within scroller y=100..736; base bounds are y=664..717.5 within y=242..717.5. This comparison does not reproduce the original feature-head selected-row regression.

Base narrow double-click navigates and closes the drawer with no inline editor. Final Enter saves the name and Escape discards the edit, preserving the open drawer and session-link focus; ArrowDown continues in both cases. All eight final desktop and five narrow scenarios passed. Both unique final WebMs and both base WebMs passed ffprobe and sample-frame decoding in the verifier. Provisional captures with setup errors and the historical checkpoint Escape failure are excluded from this publication set.

## Checks and limits

At captured final `ac1dd34f881bcc481ed089e89e5490a63e6e5115`, `bun run test` passed 4,864 tests in 366 files: unit 3,692/260, web 881/80, DB 291/25, plus one type-test file. The focused web run passed 144 tests/12 files. `env TURBO_FORCE=true bun run typecheck` passed 14 tasks with zero cached plus root tsc; `bun run build` passed uncached. Full lint checked 927 files and failed only `noShadowRestrictedNames` for the new test-local `escape`. This historical failure is retained even after a later lexical correction.

The Escape regression failed at the intended open-drawer assertion on tests-only `ae38ea072405bf9e8279c322e11c54d305866a43`, tree `e7d857b8ff61e29942fa80691960cbf2f6dfad9e`, then passed unchanged in the final focused/full runs. It also asserts ordinary Escape dismissal, so disabling the listener cannot satisfy it.

Runtime was macOS 27.0.1 arm64, Bun 1.4.2, Node 26.12.0, Vitest 4.1.10, Next 16.3.0, Turbo 2.10.8, TypeScript 7.0.2 and Biome 2.5.7. These runs do not establish results on pinned Bun 1.3.13 / CI Node 24. Full-suite DB tests used disposable Postgres; browser mutations only changed fixtures. Real auth/sign-out timing, live DB/WS and paid model/sandbox integrations were not exercised by the browser. The forced draft-cleanup interleaving establishes a storage contract regression, not an observed end-user privacy leak.

Final captures have no page errors or unexpected API/WS requests. Blocked synthetic GitHub avatars produced 15 desktop and one narrow console error; fallback marks are visible. Expired drafts remain in storage/markers until explicit removal or owner cleanup. The historical later-document-listener canceled-link case can still dismiss the drawer; reopening is the workaround, and this final capture does not prove that path fixed.

## Upstream attribution

[t3-upstream-reference.webp](t3-upstream-reference.webp) is the unmodified public T3 Code marketing asset `apps/marketing/src/assets/app-desktop.webp` at [51273020db3245f4ec29514a419d29b5dcb012dc](https://github.com/pingdotgg/t3code/blob/51273020db3245f4ec29514a419d29b5dcb012dc/apps/marketing/src/assets/app-desktop.webp). Its upstream marketing source describes a settled thread beside its pull request diff. It is a genuine upstream screenshot, not a local private-thread capture, an illustration, an independently executed T3 session, or a matched-viewport comparison.

Copyright (c) 2026 T3 Tools Inc. Distributed under the [full MIT license](t3-LICENSE.txt). The production adaptation is also attributed in `THIRD_PARTY_NOTICES.md`.

## Final code validation

V008 committed `8f64a24febb80d89ccf61e4feb93c7cdfeb38856`, parent `78b559d19297ee6118e6f75a93a55006a62b4ff2`, tree `8e3b702bfff0513ffba0c1cd59b4d63388c5e8c0`. Its only delta from captured `ac1dd34` is three test-local `escape` to `escapeEvent` substitutions. Production, configuration, dependencies and every other tracked file are byte-identical.

Checks on candidate `ac9d2f2045c2a6c717281146639873bfefd38130` with that same tree passed full lint, 927 files with no errors, the consumed/unhandled Escape regression, 1 passed with 13 name-filtered skips, and uncached typecheck, 14 tasks with zero cached plus root `tsc --noEmit`. The checkpoint's mandatory hooks passed Biome, typecheck with 14 cached tasks plus root `tsc`, and 37 tests in four files. [Check commands, times and source-log hashes](evidence.json) are under `finalCodeValidation`.

The earlier 4,864 full-suite tests, 144 focused tests, build and native results above remain attributed to captured `ac1dd34`, including its historical lint failure. This later validation does not relabel those results or media as captured at the code or publication commit.
