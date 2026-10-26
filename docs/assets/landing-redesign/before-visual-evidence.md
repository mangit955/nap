# Pinned-base visual evidence

Completed eight real browser screenshots and a 10.33-second desktop scroll recording from base `13f7fa7f478982ed9316f2348f2ee5f61214bd00`, tree `50a574c715ca9beccf5041f42ee6be29c3cf70b8`. These are BEFORE artifacts only, not candidate verification or a hand-authored reconstruction.

## Source and execution

Ran one foreground supervised sequence from `<repo>`:

```sh
python3 <skill>/scripts/run_check.py --timeout 240 -- node <run>/logs/before-visual-capture.mjs
```

Exit 0. Capture/cleanup timestamps 2026-10-25 19:59:18.114 through 20:00:09.925 UTC. The command returned after its encoder deadline timer settled. No nested runner, detached process, test, lint, production build, candidate-source/index mutation, Git worktree/branch, installation, GitHub write or paid API call occurred.

`git archive --format=tar --output=<run>/logs/before-source.tar BASE` supplied the complete tracked base into owned `<run>/visual-base-source`. Archive size 52,613,120 bytes; SHA-256 `51763362542e68bea916cdce8e301ed8437080fb9ac96ad289267d2f8bc848b5`. Every extracted tracked file was checked against its base Git blob. All archived source files remained identical after capture.

Only `node_modules` and `apps/web/node_modules` symlink to their existing dependency directories in the main checkout. All 504 base files under `packages/` matched the corresponding working shared-package file blobs before dependency reuse; no shared package mismatch. Full manifests are `logs/before-archive-manifest.json` and `logs/before-shared-package-manifest.json`. No dependency was downloaded.

Base Next cwd was `<run>/visual-base-source/apps/web`. First command was the installed Node/Next CLI with `dev --hostname 127.0.0.1 --port 3100`. Turbopack failed with the exact diagnostic `Symlink [project]/apps/web/node_modules is invalid, it points out of the filesystem root`. The supported installed `--webpack` option succeeded. No config/source change was made. Exact executable paths/argv, timestamps and raw diagnostic are in `logs/before-capture-results.json`; output is in `logs/before-server-default.log` and `logs/before-server-webpack.log`. The Turbopack panic is a bundler diagnostic, not a macOS kernel panic.

Environment: macOS Darwin 27.0.0 arm64, Node v26.12.0, Next 16.3.0, Chrome 153.0.8010.54, Playwright 1.57.0, ffmpeg 8.0.1. Set `NEXT_TELEMETRY_DISABLED=1`, `NEXT_PUBLIC_API_URL=http://127.0.0.1:3101`, `NEXT_PUBLIC_API_WS_URL=ws://127.0.0.1:3101`. Both owned ports were unused before starting. No API server was started on 3101; session reads could fail there without contacting shared services. The base rendered its signed-out public UI, including Sign in. Browser page-error record is empty. Full request list is preserved.

## Scenarios and artifacts

One isolated nonpersistent Chrome context and one page, with ordinary motion, resized serially to actual CSS viewports 1440×900 and 390×844. Waited for document fonts and visible animation settling. Each viewport captured hero at scrollY 0, the actual old How it works section via `section[aria-labelledby="how-it-works"]`, the actual Capabilities section via `section[aria-labelledby="capabilities"]`, and the bottom footer. Only real mouse wheel input moved the page. Evaluation read geometry, scroll position, headings, computed font family and font readiness; it did not modify page content/state or scroll. No storage/cookie fixture, synthetic event, auth signup, model or sandbox operation occurred. Dev-server indicator remains visible in the authentic screenshots.

Artifacts under `<run>/evidence/`:

- `before-desktop-hero.png`, `before-desktop-story.png`, `before-desktop-features.png`, `before-desktop-footer.png`, each 1440×900.
- `before-mobile-hero.png`, `before-mobile-story.png`, `before-mobile-features.png`, `before-mobile-footer.png`, each 390×844.
- `before-desktop-scroll.mp4`, H.264 1280×800 at 12fps, 10.333333 seconds, 186,181 bytes. SHA-256 `d796f38f20061f85a09451311d2da8b371b5e2bb2ce94dff4fe95d2febc5c38d`.

The recording uses real desktop wheel travel from hero through story/features to footer. CDP screencast produced 99 JPEG frames, at most about 12 retained frames/sec, quality 65 and maximum 1280×800. Raw JPEGs remain in `evidence/before-scroll-frames/`; source timestamps and receipt timing are in `logs/before-scroll-frame-timing.json`. Concat timing is `logs/before-scroll.ffconcat`. One supervised ffmpeg process encoded after browser closure, with finite 30-second deadline, threads 1, filter_threads 1, libx264, CRF 28, veryfast, yuv420p, 20-second maximum and no audio. Exact encoder argv/output are in `logs/before-capture-results.json` and `logs/before-ffmpeg.log`. ffprobe independently confirmed dimensions, rate, codec, duration and size. Screenshot sizes/checksums, actual scroll positions, headings and viewport probes are in the capture-results JSON. These viewport screenshots do not claim every pixel of each tall mobile section is visible.

I visually inspected the desktop hero and mobile story screenshots. The old light hero, its copy and native demo render from the archive. All assets remain in the run directory; none were copied or staged into the repo. Before/after publication is pending final-source acceptance.

## Ownership and cleanup

Worker PID 10485. Owned Next launchers 10504 and 10508; successful Next child 10509. Chrome startup PIDs 10516, 10525, 10526, 10529, 10530. Single ffmpeg PID 10581. Browser/context closed, server launcher/child and encoder terminated, and final ps lookup showed no recorded process remaining. Port 3100 no longer accepted connections. No tab/page/process is retained. Shared 3000 and resource.lock were untouched.

The owned archive retains 52 generated artifacts, including `.next/dev` compiled output/caches/logs/types and `apps/web/next-env.d.ts`; exact paths and sizes are recorded in the JSON. Tracked archived source changed in zero files. Archive/dependency symlinks and raw capture artifacts are preserved for review, with no running server. Established T3 fallback remains justified by the twice-failed snapshot step recorded in `reports/repair1-reproductions.md`.
