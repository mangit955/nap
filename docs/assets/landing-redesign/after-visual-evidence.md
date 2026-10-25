# Genuine AFTER visual evidence

Completed ten real PNGs and one 7.75-second MP4 on snapshot `3eb603f1ca099b27db9508699ae0767f2d0b1ea1`, tree `e34dd62a070da565c8aa05b6006fa001a35edd56`. HEAD/base remain `13f7fa7f478982ed9316f2348f2ee5f61214bd00`. Production is identical to the broad-gate-tested3b645 snapshot; the intervening delta is checker-only. BEFORE evidence remains separately pinned to base in `before-visual-evidence.md`.

## Capture method

Executed `python3 <skill>/scripts/run_check.py --timeout 180 -- node <run>/logs/after-visual-capture.mjs`, cwd the repository. Exit0; UTC 2026-10-25 20:44:34.892–20:45:20.876. Chrome 153.0.8010.54/Playwright 1.57.0 through the previously documented justified fallback. One fresh nonpersistent context/page, ordinary motion, shared localhost:3000 kept running. No personal cookies/storage and no source, style, flag, DOM-content or fixture injection. Page-provided demo apps are synthetic; all actions were real wheel/click/keys. Evaluation observed fonts, geometry, phase, viewport and scroll only.

Each 1440×900 desktop and 390×844 mobile sequence captured hero at original top, real story at Describe, a useful ready native Finance preview, features and footer. Observed fonts loaded and no horizontal page overflow in all saved scenarios. Tall mobile section captures show the actual viewport rather than a fabricated full-section composition. Existing dev-server indicator remains visible, as in BEFORE assets.

## Artifacts

All under `<run>/evidence/`, unchanged and not copied/staged/published into the repo:

- `after-desktop-hero.png`, `after-desktop-story.png`, `after-desktop-features.png`, `after-desktop-footer.png`, each 1440×900.
- `after-mobile-hero.png`, `after-mobile-story.png`, `after-mobile-features.png`, `after-mobile-footer.png`, each 390×844.
- `after-desktop-ready-preview.png` and `after-mobile-ready-preview.png`, matching those actual viewport sizes.
- `after-desktop-motion.mp4`, H.264, yuv420p,1280×800,12fps,7.750000 seconds,279,290 bytes. SHA-256 `c00588810e04b6682d96174a5ad5c86995337bcd93dcd8d8baf1ce1441d21da5`.

Screenshot files range from 52,914 to933,499 bytes. Exact dimensions, sizes, SHA-256 values, source SHA and scenario timestamps are in `logs/after-capture-results.json`. I visually inspected representative desktop hero/story/features and mobile hero/story/ready-preview/footer PNGs; they show the actual redesigned page and native UI. Root's independent artifact inspection remains required.

The recording uses actual scrolling through hero building→ready mountain reveal, a real demo reservation action, outer Build/End chapter control, Bookings/Launch thread switches, real Launch onboarding toggle, and feature History/Changes/Replay. The original 79 JPEG frames and source/receipt timing are `evidence/after-motion-frames/` and `logs/after-motion-frame-timing.json`; concat durations are `logs/after-motion.ffconcat`. Actual capture window was 7.43s, encoded 7.75s after final-frame duration. No virtual-time animation approximation or synthetic recorded UI.

## Encoding and provenance

Browser closed before encoding. One ffmpeg process at a time, threads 1/filter_threads 1, libx264, veryfast, CRF 28, no audio, finite 30-second encoder deadline and 25-second output cap. The first encode requested yuv420p but ffprobe reported full-range yuvj420p. Its bytes/probe/argv are preserved under `initialEncode` and `logs/after-desktop-motion-initial-full-range.mp4`, not presented as the final asset.

A single serial correction re-encoded the same genuine raw frames with explicit full→limited range conversion and yuv420p. Command: `run_check.py --timeout 60 -- python3 <run>/logs/after-video-range-correction.py`, exit 0. Final ffprobe independently confirms H.264/yuv420p/tv range/1280×800/12fps/7.75s. Full literal encoder argv, PID/timestamps and final checksum are in `after-capture-results.json`; output/probe are `after-ffmpeg-range-correction.log` and `after-ffprobe.json`. There were no parallel encoders or repeated capture for that correction.

## Cleanup and ownership

Capture worker/browser26621/26639 and startup service PIDs26645,26646,26647,26648 closed; first encoder26737 and range-correction encoder27176 exited. Final ps rows are empty in `logs/final3eb-cleanup.json`. Source/index before/after capture are identical and final primary unstaged/index differences are empty. No owned server/tab/browser/encoder/resource job remains. Shared port 3000, resource.lock, other worktrees and unrelated research were preserved.

Assets are local review evidence only. Root owns choosing durable repo-hosted assets, staging/publication, independent review and final checkpoint/PR workflow. No readiness claim is made here.
