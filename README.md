# PR 118 UI evidence

Evidence for https://github.com/mangit955/nap/pull/118.

Before: d0c4a0d90b7501b76722f0a2a469aecd46d86c4a.
After: tested snapshot 7480febb539fe540cf694f9bd7db6ca48bd4a45d, whose tree exactly matches published implementation dcee550948d471c6a47344ff0617d5e69112277a.

Captured with T3 collaborative Chromium, Darwin 27 arm64, Bun 1.4.2, Node 24.7.0, scripted model at localhost:3035/compaction-check. Desktop 1280x800; narrow 390x844; short landscape 844x390 with 132px composer.

Recordings show the Context popup, manual compaction and the same queued follow-up. Screenshots show before/after desktop controls, narrow popup, queued feedback and repaired short-viewport scrolling. No paid model or native-provider behavior is claimed.

This branch contains review evidence only. Preserve it so PR media links remain accessible.

## Revised composer placement and attached queue

The final-* assets show snapshot f00255eb4938f0b9318033f2d343a22ad488a512, tree a9d2c59dadd9214fc591cfd45c0be7c595e01166: ring inside the composer, right-aligned popup and attached queued prompt. These supersede the earlier after-* and repair-1-* assets. Recorded with the same scripted Chromium fixture at desktop 1280x800 and narrow 390x844. The final MP4 shows opening the popup, compaction, queueing and completion.

## Footer removal and scroll-resting composer

Current application head: 81b2f448909ea01610cdea7124e1c053c338ca35; tested snapshot: 2eb12d8adec3f50c134f7bc96dd89c17f1bab73b; identical tree: ae3d4157fc313bb682a3a2a59c275569470bc6c6. These composer-extension-sharp-* assets supersede prior final-* images for current UI.

composer-extension-before-* show pre-extension 47d9980, T3 collaborative Chromium at1280x800. Its scroll recording is programmatic scrolling; that did not collapse the old composer.

Current sharp assets use the real scripted API/WebSocket/React fixture, macOS Darwin27 arm64, Chrome153.0.8010.54 CDP, Bun1.4.2, Node24.7.0. Desktop1280x800, narrow desktop440px pane, mobile390x844. T3 capture repeatedly produced blurred media, so the documented isolated Chrome/CDP workflow supplied these crisp captures. No paid/native provider is claimed.

The6second MP4 uses48PNGframes at8fps: expanded at0s, native-wheel collapse at1.25s, click-edit expansion at3.5s, second collapse at4.375s, return-to-end expansion at5.875s. Draft and controls remain mounted. PNGs show removed success footer, collapsed pill/model strip, context popups and active compaction with attached queue. Baseline and current scenarios use the same scripted model but independent histories.

Known adaptation: desktop viewport>=768px only; expansion is immediate; narrowing an already resting draft may clip its preview until editing expands it. Actual reduced-motion emulation produced no composer animations. Safari, physical mobile keyboard, real screen reader and paid/native providers were not exercised.
