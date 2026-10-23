# Provider settings evidence

These captures use actual Nap components with scripted API responses and account states. They do not show real authentication. Production provider sign-in remains unavailable.

- Before source: `bea2cec0162465585afd654eb0b428ac29a31be0`.
- After source snapshot: `8adc43ef7de4c4bd18c3df568ff1711ce4b54e55`.
- Committed after source: `329cd52b33cb7817788f535606dc4948b29c22e2`, with the exact same tree `1c9eb26f5cd590a4d6747df884c9a06ba88fd487`.
- Local Next 16.3.0 development mode, webpack, Chrome 153.0.8010.54, Playwright 1.57.0, FFmpeg 8.0.1, arm64 macOS. Settings use their system font; a landing-only Google Font was mocked offline.
- Viewports: 1440x900 and 390x844, scale 1. Narrow captures use resized desktop Chrome.

`manifest.json` identifies each scenario, source revision and SHA-256. Connected accounts, browser links, device codes, terminal output and guest sessions are fixtures. No OAuth URL or API key was submitted. The unavailable fixture uses the production capability value and sends no sign-in request.

Before media shows Connections and its API-key dialog. The base had no Providers page. After media adds Providers, the wizard and accurate unavailable-runtime copy. Recordings contain browser navigation/loading states and compressed frames. Narrow views can scroll; some details are below the captured viewport.

Both WebMs were played in Chrome at start/middle/end, probed, and fully decoded. All media file hashes/dimensions passed audit. Targeted changed screens and video frames were visually inspected. The complete local capture has 31 PNGs and 2 recordings; this directory contains the publication subset.

Final source verification used Bun 1.4.2, Node 26.12.0 and Vitest 4.1.10. The repo declares Bun 1.3.13. Through the shared supervised resource runner, `bun run test` passed 5,093 tests across 380 files with no failures/skips, `bun run build` emitted 15 pages including `/settings/providers`, full `bun run lint` passed with two pre-existing diagnostics, and `bun run typecheck` passed on the same source tree. Deployment environment-file reads were blocked for suite/build/lint. DB tests used disposable local Postgres 17. No funded integration tests ran.

Two independent repair checks covered route guards, Escape cancellation, action errors, guest context, attribution, normalized-name acknowledgement and truthful runtime copy. Guard mutations failed as intended and were restored. Two normal repair rounds were used. The final merge-state assessment belongs to the PR, not this media directory.
