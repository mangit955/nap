# Recording viewer review

Verdict: request changes for two chapter-navigation defects. This is a review of the presentational artifact, not approval of the integrated feature or its full test gate.

Reviewed `ebedfe5b6096af7f8c1d933c95fe72d70e456f50` against parent `90fddcf8b558e4d73190534a7195d9c72d4c21bb` in `/Users/manasraghuwanshi/.t3/worktrees/nap/t3-55804d73`. The worktree was clean. Read the complete component, CSS and test changes, review README, browser check script/report, gate evidence, and relevant annotation contract/producer. Inspected the supplied desktop and phone screenshots.

## Findings

### P2: Millisecond chapter starts can select the preceding chapter and stall Next

Location: `apps/web/src/computer/recording-viewer.tsx:203-206`, with seeking at lines 290-295 and shortcut navigation at 316-319.

`seek()` writes `chapter.timeMs / 1000` to the video, then selection converts that value back with `time * 1000`. The round trip can fall below the original integer. For a chapter starting at 1001 ms, `currentTime` becomes `1.001`, but multiplying by 1000 produces `1000.9999999999999`. The predicate rejects the chapter that was just selected.

With chapters at 0, 1001 and 5000 ms, pause playback and click Test 1 or Next from Setup. The player seeks correctly, but the rail and assertion details still show Setup. Repeated Next or Shift+Right keeps seeking Test 1 because `currentIndex` remains 0. Enabling Loop at that point also chooses Setup instead of the requested test. Playing forward can mask the problem; paused chapter review remains broken.

Evidence: executed the exact `currentIndex` expression extracted from the reviewed source. It returned Setup for the 1001 ms seek. An independent native HTMLVideoElement check in the collaborative browser returned `{time:1.001, ms:1000.9999999999999, chapterMatches:false}`. That check used an unloaded native element, not the integrated viewer. Existing tests and the browser fixture only use whole-second chapter starts, 2000 and 5000 ms.

Repair: compare chapter starts and playback position in consistent units, and apply the same policy to the loop lower-bound comparison at line 250 and slider chapter lookup at lines 435-438. Add coverage for a paused seek to 1001 ms, subsequent Next/Previous shortcuts, and enabling loop after that seek.

### P2: Chapters sharing a timestamp cannot be individually reviewed

Location: `apps/web/src/computer/recording-viewer.tsx:203-206` and `290-295`.

Chapter selection has no identity separate from playback time. `findLastIndex` always chooses the last chapter at a shared timestamp. With Test 1 and Test 2 both starting at 2000 ms, clicking Test 1 shows Test 2's description and assertions. Previous from Test 2 seeks to 2000 ms and immediately resolves back to Test 2, so backward navigation gets stuck. A first test starting at zero similarly makes Setup's details inaccessible even when its rail button is clicked.

This input is allowed by the supplied view model and the current producer. `packages/runtime/src/app-test-run.ts:81-84` emits rounded elapsed milliseconds without requiring distinct chapter times. I invoked the real `AppTestRun` with a fixed clock and it accepted Setup, Test 1, an untested assertion, and Test 2 at the same timestamp. Executing the viewer's actual selection expression with starts `[0, 2000, 2000, 5000]` returned Test 2 when Test 1 was requested. The existing fixtures contain no tied chapter starts.

Repair: preserve an explicitly selected chapter for reviewing its details, even when its time equals another chapter's time. Define how playback resumes automatic chapter selection and how zero-duration chapters handle looping. Add tied-start and zero-start navigation cases. Requiring strictly increasing timestamps in a future caller would need an explicit contract change; it is not a guarantee of this artifact.

## Verification and limits

- Independently ran `bunx --no-install vitest run --project web apps/web/src/computer/recording-viewer.test.tsx`: 8/8 passed. No tests or implementation files were edited.
- Source inspection found matching cleanup for all seven media listeners and the scoped keyboard listener. A changed URL remounts the player, pauses the old element, and suppresses its late promise failures. Existing tests exercise source replacement and listener removal. No additional confirmed lifecycle defect was found within this scope.
- The artifact stays within the approved presentational boundary. The caller owns the URL and counts; media uses credentialed CORS; the download uses the same owner URL. There is no new event, runtime, route, backend, audio-control or DOM-replay wiring.
- Worker browser evidence uses the actual component with synthetic media. Its fullscreen check establishes entry and exit only; it exits through `document.exitFullscreen()`. Fullscreen playback controls, keyboard focus, Escape behavior and touch interaction still need the parent's real integrated UI check. These are coverage gaps, not asserted defects here.
- The fixture server was not running on port 4321. I did not start a build or regenerate browser artifacts. The new browser check was limited to the native media-time arithmetic above. No integrated UI, owner authorization, cookie delivery, download headers, range requests, mobile touch or screen-reader behavior was independently verified in this round.
- Worker typecheck/lint and mutation results were reviewed as supplied evidence, not rerun. The reported full suite remains red at the unchanged clipboard-fallback test. The separate #174 fix does not waive that gate. Run the required full checks on the actual integrated head after repairs, and retain the planned integrated UI and matching-reference review before closing the feature.

No code changes, paid calls, builds, Devin interaction, subagents, pushes or PR operations were performed. Only this requested report was written.
