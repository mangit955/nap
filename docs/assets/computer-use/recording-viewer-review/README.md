# Recording viewer preparation

This is the presentational sub-unit of [#154](https://github.com/mangit955/nap/issues/154). The issue stays open. The recording producer, owner route, event fold, Watch recording wiring and matching passive reference are not part of this commit.

## Integrate

Cherry-pick the local WIP commit into the computer-use branch. Import `RecordingViewer` and `RecordingView` from `apps/web/src/computer/recording-viewer.tsx`.

Mount `<RecordingViewer recording={selectedRecording} onClose={closeViewer} />` while the viewer is open. Unmount it in `closeViewer`. Passing `null` renders the requested empty state inside the modal; it does not close the viewer.

The UI-owned `RecordingView` has only `videoUrl`, `title`, `annotations` and `counts`. Each annotation pairs `ComputerAnnotation` from `@nap/shared/computer` with `timeMs` on the video's source timeline. Counts are supplied by the caller as passed/failed/untested. This type is a view model, not a new event or HTTP contract.

Supply `videoUrl` as the owner API media URL. The native video sends cookies through `crossOrigin="use-credentials"`; the download anchor uses that same URL. A cross-origin API must allow credentialed CORS for the web origin. Serve a playable video with correct content type, range support and download disposition when appropriate. The browser may ignore the `download` attribute across origins, so the server owns the final download behavior. This unit never accepts an object key or a VNC credential and makes no media fetch of its own.

A synthetic Setup chapter starts at zero. Each `test_start` opens a Test chapter. Setup/action descriptions and assertions belong to the preceding chapter. Repeated assertion IDs in a chapter replace their earlier declaration with the latest result. Source URLs key the player, so switching recordings discards playback state, removes old listeners, pauses the old element and ignores pending failures from it. Use a distinct owner URL for each recording.

Keyboard handling exists only while the modal/player is mounted. Focus stays in the modal and returns to the opener on unmount. Space toggles playback when the video or another noninteractive area has focus; native buttons, links and form controls keep their normal Space behavior. Shift+Left/Right navigates chapters, including from a focused chapter button. Looping follows the selected chapter when navigating. The range slider seeks the recording. Full screen uses the native video fullscreen API. No audio or DOM replay controls are provided.

## Evidence and provenance

The PNGs render the actual React component and its CSS module, using a local eight-second silent WebM and invented notes-app annotations. The video contains static geometric shapes; it is not a recording of an agent or a real app test. `fixture.css` supplies the existing workspace token values because this fixture runs outside Next. The viewer sizes its own close icon independently of Tailwind.

- `nap-viewer-desktop.png`: 1440×1000, first test with a passed assertion.
- `nap-viewer-phone-reduced.png`: 390×844, second test, reduced transparency and motion. The dialog scrolls vertically and the chapter rail scrolls horizontally.
- `nap-viewer-empty.png`: requested empty copy.
- `nap-viewer-unavailable.png`: native media error with playback disabled.
- `browser-report.json`: browser version, timestamp, computed glass values and executed checks.

No matching Devin recording-viewer reference was available. No Devin interaction or reference fabrication occurred. The older standalone mockup is design evidence only. Paired reference/product evidence remains a condition for closing the integrated ticket.

The collaborative preview opened the fixture, then snapshot failed twice with `Preview automation snapshot timed out after 15000ms.` The captures use a dedicated headless Chrome under the repository's documented CDP fallback. The check refuses the passive Devin port. Browser checks exercise native playback time, chapter looping across video end, Space, Shift+Arrow, fullscreen entry/exit, modal focus/inert background, Escape/focus return, 390px overflow, computed glass and reduced-transparency fallback. They do not establish real owner authorization, download headers, network range behavior, mobile touch, an OS keyboard or a screen-reader audit. CDP clicks in the script focus the target before calling its DOM click method.

## Reproduce

Run from the repository root after `bun install --frozen-lockfile`:

```sh
node docs/assets/computer-use/recording-viewer-review/serve.mjs
```

Start a dedicated browser in another terminal:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9348 --user-data-dir=/tmp/nap-recording-review-chrome --no-first-run --no-default-browser-check about:blank
```

Then run:

```sh
node docs/assets/computer-use/recording-viewer-review/check.mjs
bunx vitest list --project web apps/web/src/computer/recording-viewer.test.tsx
bunx vitest run --project web apps/web/src/computer/recording-viewer.test.tsx
bun run test
bun run typecheck
bun run lint
```

`serve.mjs` uses the installed Vite dependency of the existing React plugin. It changes no package manifest or Next route. Its server is local to port 4321. `fixture.webm` was generated offline by ffmpeg from a color source with drawbox filters, VP9, 1024×768, 10fps, eight seconds, no audio. No service, model or sandbox call is required.

## Guards and integration review

Tests preceded the exported component. Missing-import failure was followed by eight failing assertions against an empty component. Deliberate mutations then proved that the tests reject anonymous media cookies, omitted chapter rewind and omitted native listener cleanup. The mutations were restored. `mutation-*.txt` contains their actual failing output.

The initial full baseline reported an existing `apps/api/src/github/git-broker.test.ts` subprocess startup failure at line 318. A later full run passed without changing that file. A later unconstrained full rerun reported seven existing 5-second web-test timeouts and one existing missing Model button assertion while other worktrees ran suites. `full-test-red.txt` preserves that output. The four-worker full run reported 5,141 passes and one existing clipboard-fallback failure in `workspace/file-panel.test.tsx`. It did not turn the full gate green. An isolated rerun of the file-panel suite with the viewer suite then passed all 13 tests. `gates.txt` preserves the final commands and their output. Lint's existing globals.css specificity warning and sandbox test template-literal information are outside this seam.

The component imports only declared web dependencies and the existing icon module. It adds no event/chat/runtime behavior, routes, providers or subscription. `apps/web/tsconfig.json` includes `src`; the web Vitest glob collects the `.test.tsx`; Biome includes the TSX/CSS module and fixture. CI's existing test/typecheck/lint commands and lefthook's typecheck plus unit/web changed-test gates cover the new shipped files without configuration changes. The fixture's JavaScript is linted and explicitly browser-checked; it is a documentation artifact outside TypeScript and Vitest. No frozen v1 plan/progress or architecture documentation needs changing for an unintegrated presentation module.
