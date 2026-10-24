# Recording and cancellation review, round 2

Reviewed the uncommitted tree in `/Users/manasraghuwanshi/.t3/worktrees/nap/feat-computer-use`, based on HEAD `d1a1f9378210adbb45df0338f6bd79ae92c17595`, on 2026-10-24. Two P2 findings remain below. Neither repeats the two repaired findings from round 1. No P0/P1 defect established.

Read CLAUDE.md, GOTCHAS Sandbox/Types/Testing, ADR0018, and `/tmp/nap-recording-driver-review.md` in full. Re-read the recording port, recorder, operations, driver, protocol, E2B recording adapter, fake, and their focused tests, plus the headroom check and local smoke setup. This review covers the current recording/cancellation implementation and repair consequences. Runtime composition, upload/indexing/media routes, and production readiness remain outside scope.

## Confirmed findings

### P2: A repeated begin deletes an ended capture before finish can retrieve it

Location: `packages/sandbox/src/desktop-recorder.ts:185-187` and `:215-220`.

If an existing capture has stopped but has no `complete.json` yet, `begin(id)` throws "This recording already ended." inside the expanded cleanup block. The catch then recursively removes the entire capture directory. This can occur after the encoder's size/duration stop, or when a failed finish has stopped the encoder but has not written completion metadata. A repeated begin now destroys the video that finish could otherwise recover. Explicit discard has not been requested.

The method already supports repeated begin for both running and completed captures. Rejecting an ended capture is reasonable; deleting its existing evidence as though this invocation had created it is the defect.

Reproduction through the actual `DesktopRecorder`, using its process-host seam: begin succeeds; the host transitions to stopped; repeat begin throws; capture.mp4 disappears; finish fails with ENOENT for process.json. Evidence: `/tmp/nap-recording-round2-retry.ts` and `/tmp/nap-recording-round2-retry.log`.

```json
{"fileBeforeRetry":true,"retryError":"Error: This recording already ended.","fileAfterRetry":false}
```

Keep cleanup for newly spawned capture effects, but do not remove an existing stopped capture when rejecting a repeated begin. Add a regression proving that finish still retrieves the original bytes after this rejected call. This reproduction establishes filesystem/lifecycle behavior using a scripted process host, not a live duration/size stop.

### P2: Forced cleanup can kill the timeout monitor and orphan ffmpeg

Location: `packages/sandbox/src/desktop-recorder.ts:45-53`, `:99-114`, and `:255-261`.

The returned process identity now belongs to GNU timeout. The recorder still escalates with `process.kill(identity.pid, "SIGKILL")`, which kills only that monitor. Its local five-second deadline starts immediately after sending SIGINT; timeout's own five-second kill-after timer starts when timeout handles that signal. If the monitor handles it late and ffmpeg cannot drain, the recorder's deadline wins. Killing timeout removes the watchdog while leaving its ffmpeg child alive. Subsequent discard checks only the dead monitor and removes files without stopping the encoder. A new recording can also pass the active-process check.

Confirmed with the unchanged default process host, real GNU timeout, ffmpeg and Xvfb in the existing local Docker image, with networking disabled and the repository mounted read-only. After a successful begin, the reproduction pauses Xvfb to stall capture and delays timeout's SIGINT handling by 250 ms using SIGSTOP/SIGCONT. Actual finish then reports:

```json
{"failure":"Error: Capture did not drain.","elapsedMs":5001,"monitor":"Z","encoder":"S","files":true}
{"afterDelay":{"monitor":"missing","encoder":"S"}}
{"afterDiscard":{"monitor":"missing","encoder":"S","files":false}}
```

Evidence: `/tmp/nap-recording-round2-linux-delayed.ts` and `/tmp/nap-recording-round2-linux-delayed.log`. The script explicitly kills its remaining processes in finally; the container is disposable.

This is a fault-injection reproduction of the forced-stop branch. It does not establish naturally occurring 250 ms monitor scheduling delay or production frequency. The control experiment stalled Xvfb without delaying timeout: timeout killed the child, finish rejected the invalid capture, and the files remained. Evidence: `/tmp/nap-recording-round2-linux.ts` and `/tmp/nap-recording-round2-linux.log`.

Make forced cleanup own the encoder as well as the monitor, with appropriate identity checks, and do not treat monitor disappearance alone as proof that capture has drained. Test a delayed/unresponsive monitor and verify no live encoder remains before allowing deletion or another capture.

## Repairs verified

- The encoder stop threshold is now 14,000,000 bytes, while acceptance remains capped at 16,000,000. The supplied real-encoder script/result shows a 14,161,384-byte clip accepted by actual finish, with all 573 frames decoded. I read the script and result; I did not rerun that encode. This closes the demonstrated 16 MB producer/consumer mismatch. It is empirical headroom evidence, not a proof of maximum overhead for every encoder version/content.
- Both metadata writes now sit inside startup cleanup, and the returned identity remains available even when process.json cannot be persisted. The focused tests confirm stop is called for each write failure. Failed drain preserves existing recovery files. The original missing-cleanup finding is addressed; the overly broad cleanup in the first finding is a separate consequence.
- Numeric progress fields now require a terminating newline. The partial-number regression passes and preserves 375 ms rather than returning zero. No claim is made about the frequency of partial writes from deployed ffmpeg.
- The base64 validators use the linear expression with length bounds. The large recording/screenshot cases and malformed-input cases pass. I found no new defect in that repair.
- The durable cancellation marker and two claim checks remain intact. No new cancellation/claim ordering defect established.

## Verification and limits

I ran only six focused Vitest files: recorder, protocol, operations, E2B recordings, fake recordings, and driver CLI. All **38 tests passed**, recorded in `/tmp/nap-recording-round2-focused.log`. I also inspected the supplied red/green regression logs. Those prior mutations were not rerun.

No repository source was changed. No full suites, builds, paid calls, Devin access, push, or PR work was performed. Temporary reproduction scripts/logs and this report were written under /tmp. The Linux experiments reused an already-built image and imported the current source through a read-only mount.

Not established here: production/E2B large-exec-output behavior; a real ten-minute wall-clock expiry; actual PID reuse/check-to-signal races; cancellation during real active input or while waiting on flock; recovery after simultaneous identity-persistence and stop failure when no valid identity reached disk. The supplied happy-path Linux smoke does not cover the monitor escalation race above. Cross-family review availability and the parent's ongoing smoke rerun are context, not independent evidence from this reviewer. This is not a merge/readiness verdict.

Final recorder SHA-256: `ddfbd34b344e5f62a1fb10fc9d09b478ee9d6ec12dcc940ddd493952d320bb7f`.
