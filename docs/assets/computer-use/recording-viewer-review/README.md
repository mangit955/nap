# Recording viewer preparation

This is the presentational sub-unit of [#154](https://github.com/mangit955/nap/issues/154). The issue stays open. The recording producer, owner route, event fold, Watch recording wiring and matching passive reference are not part of this commit.

## Integrate

Cherry-pick the local WIP commit into the computer-use branch. Import `RecordingViewer` and `RecordingView` from `apps/web/src/computer/recording-viewer.tsx`.

Mount `<RecordingViewer recording={selectedRecording} onClose={closeViewer} />` while the viewer is open. Unmount it in `closeViewer`. Passing `null` renders the requested empty state inside the modal; it does not close the viewer.

The UI-owned `RecordingView` has only `videoUrl`, `title`, `annotations` and `counts`. Each annotation pairs `ComputerAnnotation` from `@nap/shared/computer` with `timeMs` on the video's source timeline. Counts are supplied by the caller as passed/failed/untested. This type is a view model, not a new event or HTTP contract.

Supply `videoUrl` as the owner API media URL. The native video sends cookies through `crossOrigin="use-credentials"`; the download anchor uses that same URL. A cross-origin API must allow credentialed CORS for the web origin. Serve a playable video with correct content type, range support and download disposition when appropriate. The browser may ignore the `download` attribute across origins, so the server owns the final download behavior. This unit never accepts an object key or a VNC credential and makes no media fetch of its own.

A synthetic Setup chapter starts at zero. Each `test_start` opens a Test chapter. Setup/action descriptions and assertions belong to the preceding chapter. Repeated assertion IDs in a chapter replace their earlier declaration with the latest result. Source URLs key the player, so switching recordings discards playback state, removes old listeners, pauses the old element and ignores pending failures from it. Use a distinct owner URL for each recording.

Keyboard handling exists only while the modal/player is mounted. Focus stays in the modal and returns to the opener on unmount. Space toggles playback when the video or another noninteractive area has focus; native buttons, links and form controls keep their normal Space behavior. Shift+Left/Right navigates chapters, including from a focused chapter button. Looping follows the selected chapter when navigating. The range slider seeks the recording. Full screen uses the native video fullscreen API. No audio or DOM replay controls are provided.

The viewer initially selects Setup. Clicking a chapter or using Previous/Next selects that chapter by index, independently of the media clock. Paused media events preserve that selection, including chapters with equal timestamps. Playback without a loop resumes automatic selection, choosing the last chapter at or before the clock position. A chapter selected during playback remains explicit until the next playing `timeupdate`. Moving the slider also selects by time.

Media positions round to the nearest integer millisecond for chapter and loop comparisons. This matches annotation precision and handles both floating-point round trips and native microsecond truncation. Chrome returned `1.000999` after a `1.001` seek in this fixture. A loop holds its chapter identity and covers the interval from its start to the next chapter, or the media end for the last chapter. Chapters with no positive playback duration remain selectable, show an explanation, and cannot loop. Navigating or scrubbing into one cancels an active loop.

## Evidence and provenance

The PNGs render the actual React component and its CSS module, using a local eight-second silent WebM and invented notes-app annotations. The video contains static geometric shapes; it is not a recording of an agent or a real app test. `fixture.css` supplies the existing workspace token values because this fixture runs outside Next. The viewer sizes its own close icon independently of Tailwind.

- `nap-viewer-desktop.png`: 1440×1000, first test with a passed assertion.
- `nap-viewer-phone-reduced.png`: 390×844, second test, reduced transparency and motion. The dialog scrolls vertically and the chapter rail scrolls horizontally.
- `nap-viewer-empty.png`: requested empty copy.
- `nap-viewer-unavailable.png`: native media error with playback disabled.
- `nap-viewer-setup-zero.png`: Setup selected separately from a test starting at zero.
- `nap-viewer-tied-chapter.png`: the first chapter at 1001 ms, with its own assertion and disabled zero-duration loop.
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
node docs/assets/computer-use/recording-viewer-review/mutations.mjs
bun run test
bun run typecheck
bun run lint
```

`serve.mjs` uses the installed Vite dependency of the existing React plugin. It changes no package manifest or Next route. Its server is local to port 4321. `fixture.webm` was generated offline by ffmpeg from a color source with drawbox filters, VP9, 1024×768, 10fps, eight seconds, no audio. No service, model or sandbox call is required.

Open `http://127.0.0.1:4321/?chapters=regressions` for the shared-timestamp fixture. The browser check covers that fixture after the original whole-second playback, fullscreen, focus, narrow layout, empty, and error checks. Fullscreen evidence still establishes entry and exit through `document.exitFullscreen()` only. Fullscreen controls, fullscreen Escape behavior, mobile touch, and screen-reader behavior require the integrated review.

## Guards and integration review

Tests preceded the exported component. Missing-import failure was followed by eight failing assertions against an empty component. Deliberate mutations then proved that the tests reject anonymous media cookies, omitted chapter rewind and omitted native listener cleanup. The mutations were restored. `mutation-*.txt` contains their actual failing output.

The initial full baseline reported an existing `apps/api/src/github/git-broker.test.ts` subprocess startup failure at line 318. A later full run passed without changing that file. A later unconstrained full rerun reported seven existing 5-second web-test timeouts and one existing missing Model button assertion while other worktrees ran suites. `full-test-red.txt` preserves that output. The four-worker full run reported 5,141 passes and one existing clipboard-fallback failure in `workspace/file-panel.test.tsx`. It did not turn the full gate green. An isolated rerun of the file-panel suite with the viewer suite then passed all 13 tests. `gates.txt` preserves the final commands and their output. Lint's existing globals.css specificity warning and sandbox test template-literal information are outside this seam.

The component imports only declared web dependencies and the existing icon module. It adds no event/chat/runtime behavior, routes, providers or subscription. `apps/web/tsconfig.json` includes `src`; the web Vitest glob collects the `.test.tsx`; Biome includes the TSX/CSS module and fixture. CI's existing test/typecheck/lint commands and lefthook's typecheck plus unit/web changed-test gates cover the new shipped files without configuration changes. The fixture's JavaScript is linted and explicitly browser-checked; it is a documentation artifact outside TypeScript and Vitest. No frozen v1 plan/progress or architecture documentation needs changing for an unintegrated presentation module.

## Repair evidence

Both accepted P2 findings in `incoming-review.md` are repaired. `repair-regressions-red.txt` records five failures against the original viewer before repair, alongside its eight passing tests. `repair-native-precision-red.txt` records the additional failure for native microsecond truncation before normalization. The suite now has fourteen tests. New cases query accessible roles and names, then inspect chapter details or native media state.

`mutations.mjs` runs eleven independent mutations and restores the source in `finally`. `repair-mutation-*.txt` records failing assertions for chapter identity, timeline precision, loop lower bound, automatic selection on play and during playback, zero-duration controls and navigation, slider selection, chapter rewind, media listener cleanup, and owner cookies. The first slider mutation survived because the test moved the slider only with looping off. `repair-slider-mutation-survived.txt` and `repair-mutation-first-pass.txt` retain that gap; the test now exercises slider changes with looping active and rejects the same mutation.

The actual component and CSS were reviewed after repair. Desktop and phone captures retain the original layout; the two new desktop captures show the zero-duration explanation, disabled loop, and distinct chapter details without clipping. No CSS change was needed. `browser-report.json` records native playback and loop checks, the raw 1001 ms seek result, browser version, and zero runtime exceptions. These are synthetic local artifact checks, with no owner route, recording producer, or backend connection.

`repair-baseline.txt` records 5,170 passing tests before integration. `repair-full-test-red.txt` preserves the full run after the first repair: 5,181 passed and two unchanged tests failed, the Git broker import timeout and AppShell's missing Model button. The original `full-test-red.txt` and `gates.txt` remain intact, including the clipboard race assigned to #174. No unrelated test was changed or excluded, and no retry loop was used. The final gate run follows the additional native-precision repair and mutation-driven coverage changes.

`repair-final-full-test.txt` records the final unmodified `bun run test` command: 5,182 passed, two failed, and no type errors. Both failures are in unchanged `postgres-sandbox-capacity.db.test.ts`: the hundred-admission test timed out at five seconds, then the per-user admission test received zero admissions instead of two. Other worktrees were running suites concurrently; no cause was established or repaired here. This is a red full-suite gate. `repair-viewer-green.txt`, `repair-collection.txt`, `repair-typecheck.txt`, and `repair-lint.txt` record fourteen passing and collected viewer tests, passing full typecheck, and passing lint with the existing CSS warning and sandbox-test information. Raw text evidence retains runner formatting whitespace.

Parent handoff remains the same: integrate the real owner recording URL and opening action, run the integrated gate, check the real media lifecycle and fullscreen interactions, and obtain the matching Devin reference. Keep #154 open. No paid calls, builds, Devin actions, push, or PR occurred during repair.
