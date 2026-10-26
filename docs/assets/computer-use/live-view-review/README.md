# Live desktop review

`devin-reconnecting.png` was captured passively from the already-open Devin session on 2026-10-24 at 06:25 UTC. REA's `capture-web-screenshot` observed the viewport through the existing loopback CDP endpoint. No click, typing, navigation, scrolling or JavaScript evaluation was performed.

The reference shows the Computer pane reconnecting, its timeline, previous/next controls, Live pill, quality menu and fullscreen placement. Nap deliberately omits audio under the approved scope.

`devin-live.png` is a second passive capture of the same tab, showing its live endpoint. The recording viewer and takeover state were not visible in either capture. The matching viewer/takeover references remain missing. No Devin code, assets or icons are used in Nap.

Nap's captures render the actual ComputerPane, noVNC client, input overlay and recording viewer in Next. `nap-computer-live.png` and `nap-computer-disconnected.png` are the corresponding live and disconnected states. Other captures cover driving, busy input, screenshot history, a 390px layout, and the recording viewer. The screen pixels come from a local raw RFB fixture, not Chrome or E2B. The owner input HTTP replies are fake. The history JPEG is Nap's own synthetic fixture.

The browser check exercises the real view-only transport, quality selection, fresh-credential Retry, disconnect on history, idle-only control feedback, remote Escape and Shift+Escape, one Remote computer application role, aligned letterbox coordinates, and narrow layout. The server records zero input/clipboard messages on the VNC wire. API and PostgreSQL tests separately cover ownership and project exclusion; the fixture cannot prove them.

For playback, a real ffmpeg MP4 from the [Linux capture check](../../../research/computer-recording-linux/README.md) passes through the actual ranged owner route. The media fixture supplies fake identity and in-memory storage. Chrome decodes and plays it, navigates chapters, downloads byte-identical bytes through the attachment response, and closes/unmounts the viewer. Chapter annotations in this fixture are synthetic; this does not establish real runtime-to-video timing or real owner cookies. [Native observations](browser-evidence.json) record the scope.

The [first integration review](integration-review-round1.md) found a stale activity-boundary bug and two smaller input issues. The Computer pane now consumes chat's existing authoritative activity observation, including its idle cursor, while retaining unfinished capture activity. [Thirteen mutations](guard-results.txt) were caught. Run `bash docs/assets/computer-use/live-view-review/guard-mutations.sh` only in an otherwise idle checkout; it restores every source and writes per-case output under `/tmp`.

Visual inspection also caught a glow painted over the framebuffer. The [native guard failed](glow-red.txt) before moving the rim behind the opaque frame. The final browser check samples unchanged interior pixels during the visible pulse. A first coordinate oracle incorrectly compared the whole input box to the letterboxed canvas; the corrected check compares their effective desktop rectangles.

## Capture harness

The temporary review harness was removed after the captures. Its source is preserved at [pinned commit `02343767`](https://github.com/mangit955/nap/blob/02343767e06bc58e0dc0c517ca3ea53b2850652a/apps/web/src/testing/live-computer-review.tsx).

Browser-first attempts used T3 preview; two snapshots returned `Preview automation snapshot timed out after 15000ms.`, so a separate Chrome workflow was used.

Real E2B streaming, physical owner input, cloud cancellation, recording transfer limits, and matching viewer/takeover references remain pending. See the [next paid validation scope](../../../research/computer-use-cloud-validation.md).
