# PR #115: visual and verification evidence

These are existing captures and results from the review of [PR #115](https://github.com/mangit955/nap/pull/115), published after the review because the first PR description left them only on the local machine. No screenshot was edited or recreated for this upload. This evidence branch contains artifacts only; the application PR head remains `4930e97dab644af952c318e70dcdfa9e2ab7cc31` against `9ca9cd5074edabde49ba1014849aff32057a90f6`.

## Provenance

The final verified snapshot `5e115c34f609cc5574c63873e4f8974c1ec9f921` has exactly the same tree as published application commit `4930e97`: `f3e781fb55d43dc8fd58bf09f7a6ba2416c3e4ff`. Final recovery/menu screenshots come from that tree. Earlier workspace/dashboard/responsive screenshots are from reviewed snapshot `777f193e` (tree `1b4bb068`); those areas did not change in the final recovery/menu repair. The **before** screenshot shows pre-repair feature commit `5a150ab3`, not `main` or the original pre-redesign dashboard. No main-branch browser capture exists.

The browser used deterministic account/API/model/socket/preview fixtures, not real provider or production account behavior. All identities visible in these images are fixtures. No video recording was captured; these are screenshots, not a recording of actions. The final browser fixture used already-prepared JPEG frames, while the earlier media run actually decoded a tiny PNG and WebM.

## Visuals

| Capture | Source | What it shows |
| --- | --- | --- |
| [desktop-workspace.png](screenshots/desktop-workspace.png) | `777f193e` | Desktop workspace, sidebar and composer |
| [dashboard-mobile.png](screenshots/dashboard-mobile.png) | `777f193e` | Dashboard branding and composer |
| [preview-before-mobile.png](screenshots/preview-before-mobile.png) | `5a150ab3` | Before repair: mobile preview controls inaccessible |
| [preview-after-mobile.png](screenshots/preview-after-mobile.png) | `777f193e` | After repair: route, reload and open controls visible |
| [first-prompt-recovery-mobile.png](screenshots/first-prompt-recovery-mobile.png) | `5e115c34` | Final tree: refused first prompt restored with references |
| [edited-retry-mobile.png](screenshots/edited-retry-mobile.png) | `5e115c34` | Final tree: edited text/model and video-only retry |
| [session-actions-mobile.png](screenshots/session-actions-mobile.png) | `5e115c34` | Final tree: keyboard focus inside session actions |

## Local checks on the final application tree

Environment: macOS 27.0.1 arm64, Bun 1.4.2, Node 24.7.0, Vitest 4.1.10; Chrome 153.0.8010.54 and Playwright 1.57.0 for browser checks.

| Command | Recorded result | Output |
| --- | --- | --- |
| `bun run test` | 4,318 tests / 315 files passed; no type errors | [test log](logs/test.txt) |
| `bun run typecheck` | 14 packages plus root passed; 13 valid cache hits, changed web executed | [typecheck log](logs/typecheck.txt) |
| `bun run lint` | 817 files, no diagnostics | [lint log](logs/lint.txt) |
| `bun run build --force` | Fresh production build, cache bypass | [build log](logs/build.txt) |
| Commit hooks | Biome/typecheck and 194 tests / 14 files passed | [hook log](logs/commit-hooks.txt) |

[Final gate report](reports/final-candidate-gates.md) records the exact candidate, timings, earlier failed typecheck, correction, and mutation evidence. [Final browser report](reports/final-candidate-browser.md) records refusal recovery, exact/edited retries, still previews, no automatic repeats, and mobile portal/dialog keyboard behavior. [Earlier browser report](reports/candidate2-browser.md) records native tiny-media preparation and the original broad run's locator failure followed by its successful narrow continuation. [Regression reds](reports/final-red.md) demonstrate the pre-repair recovery/menu defects; [round-one](reports/round1-red.md) and [round-two](reports/round2-red.md) reports retain the earlier repair evidence.

The build ID for the final browser run is `6l0ofJHG6QIniogm3bGRE`. Browser checks used fake service boundaries and do not establish live model, microphone, auth/sandbox, cross-browser, capacity or production rollout behavior. Native decoder peak-memory bounds and pre-existing queued-cancel reconciliation remain documented limitations in the PR.

## GitHub CI

These host-owned results cover application commit `4930e97`:

- [Pull-request CI run](https://github.com/mangit955/nap/actions/runs/39204087687) — check and python passed.
- [Push CI run](https://github.com/mangit955/nap/actions/runs/39204082289) — check and python passed.

[manifest.json](manifest.json) records screenshot SHA-256 values and selected captured command metadata. Logs/reports preserve their results; only local machine path prefixes were replaced with `<repo>`, `<review-run>` or `<home>`. Historical reports may refer to other local scratch files that are not included in this publication.
