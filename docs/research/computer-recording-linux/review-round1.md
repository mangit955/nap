# Recording and cancellation review

Reviewed the uncommitted parent tree at `/Users/manasraghuwanshi/.t3/worktrees/nap/feat-computer-use`, based on HEAD `d1a1f9378210adbb45df0338f6bd79ae92c17595`. Final source check: 2026-10-24 06:30 UTC. Two P2 findings below. No P0/P1 defect established.

Read CLAUDE.md, GOTCHAS Sandbox/Types/Testing, ADR0018, the recording port, recorder and operations implementations/tests, E2B desktop adapter and recording tests, protocol, driver and CLI tests, fake/tests, smoke scripts, and Linux evidence. Also checked the existing adapter tests and SandboxManager exec boundary. The parent changed protocol validation during this review; I reread its final linear base64 validator and new protocol tests. The findings below concern unchanged recorder code.

No repository files were modified, no suites/builds were run, and no paid/network model calls, Devin access, pushes, or PR actions were made. Reproductions used temporary files, a fake process host through the actual recorder, and local ffmpeg. Runtime composition, upload, routes, and production/E2B readiness are explicitly outside this review's defect scope.

## Confirmed findings

### P2: Leave headroom between ffmpeg's stop threshold and the accepted output ceiling

**Location:** `packages/sandbox/src/desktop-recorder.ts:186-187`, `:76-77`, and `:232-233`.

`begin()` passes the full 16,000,000-byte acceptance limit to ffmpeg's `-fs`. That encoder threshold does not guarantee a final MP4 at or below the same size. With the exact codec/muxer settings here, ffmpeg can stop successfully at its file threshold and produce a larger, valid file. `finish()` then rejects the entire capture before probing it. Every repeat of finish rejects the same file. A sufficiently active recording can therefore lose all usable video before the ten-minute limit.

**Observed reproduction:** local ffmpeg 8.0.1 on macOS, substituting a deterministic 1024x768, 8-fps video source for X11 while retaining the implementation's encoding and file-limit settings:

```sh
ffmpeg -nostdin -loglevel error -y \
  -f lavfi -i testsrc2=size=1024x768:rate=8 -an \
  -c:v libx264 -preset ultrafast -tune zerolatency -bf 0 \
  -crf 30 -pix_fmt yuv420p -t 600 -fs 16000000 \
  -movflags +faststart -stats_period 0.1 \
  -progress /tmp/nap-recording-review-size.progress \
  /tmp/nap-recording-review-size.mp4
```

It exited 0 and produced **16,269,521 bytes**, duration **82.25 seconds**, with 658 frames. ffprobe accepted it, and decoding the entire file with ffmpeg exited 0. Feeding that file to the real `DesktopRecorder.finish()` with a stopped process host produced:

```json
{"bytes":16269521,"failure":"Error: Capture size is invalid.","probes":0}
```

Re-run the recorder half with `bun /tmp/nap-recording-review-size.ts`; output is retained in `/tmp/nap-recording-review-size.log`. This is a local encoder/validation mismatch, not an E2B large-output claim. The exact overshoot can vary by ffmpeg version and content.

**Repair:** retain the strict external size validation, but use a lower encoder stop threshold with allowance for packet/muxer overhead, or another bounded finalization approach that preserves a usable clip. Exercise the size-triggered stop with real encoded video; rejecting a manually oversized fixture does not test this producer/consumer agreement.

### P2: Protect metadata persistence with the same cleanup as first-frame readiness

**Location:** `packages/sandbox/src/desktop-recorder.ts:183-194`, with recovery dependent on `:245-249`.

The encoder has already been started when `process.json` and `active.json` are written. Both writes are outside the `try` that discards failed startup. If either write throws, `begin()` fails without stopping the encoder. Failure to persist `process.json` is worse: later `discard()` has no usable durable identity with which to stop it. The detached encoder can keep recording after a failed begin, and a missing active record also permits another recording to start.

**Observed fault-injection reproduction:** `/tmp/nap-recording-review-repro.ts` imports the actual recorder and uses its existing `RecordingProcessHost` seam. After host.start marks an encoder live, it makes `process.json` a directory so the actual writeFileSync throws EISDIR. The recorder calls stop **zero times**, leaves the host live, and creates no active record:

```json
{"case":"identity-persist-failure","encoderStillLive":true,"stopCalls":0,"activeExists":false}
```

Run `bun /tmp/nap-recording-review-repro.ts`; the complete error and result are retained in `/tmp/nap-recording-review-repro.log`. This proves missing cleanup when metadata persistence fails. It does not claim a naturally occurring filesystem fault or a live Linux process leak was observed. A permission or I/O error at the same write takes the same branch.

**Repair:** extend startup cleanup to cover all effects after a successful spawn. Keep the returned identity available for stopping even if its durable write failed; calling discard alone cannot recover an identity that never reached disk. Add focused failure-injection coverage for both metadata writes and preserve retry state if stopping itself fails.

## Reproduced edge behavior with an unproven production trigger

**Partial numeric progress can move the clock backward**, `packages/sandbox/src/desktop-recorder.ts:219-224`. After a complete `out_time_us=375000` report, a file ending in `frame=4\nout_time_us=5` yields timestamp **0 ms**, because `$` also matches end-of-file. The existing partial-progress test only covers an empty value, which falls back to the previous time. The temporary reproduction above observed `{"case":"partial-progress","before":375,"duringPartialWrite":0}`.

I did not establish that the deployed ffmpeg's buffered progress writes expose a truncated numeric line to a concurrent regular-file reader. Accordingly this is not counted as a confirmed production bug. If partial progress is a supported input condition, consume only complete newline-terminated fields or complete `progress=` blocks and test a partially written number.

## Checks and remaining limits

- The cancel marker is written before identity lookup, and claim checks it both before and after atomic identity publication. This handles the inspected cancellation/claim ordering, including delayed dispatch after cancellation. Markers deliberately survive completion. I found no proven new defect in that ordering.
- Recorder and operation signalling check PID plus Linux start ticks. Recorder cleanup also treats zombies as stopped. I did not exercise actual PID reuse or the narrow check-to-signal race. The unit test that mocks running=false does not independently prove Linux process identity handling.
- Failed drain prevents finish metadata and prevents discard from deleting the capture directory. No new deletion-before-drain defect was established. Actual forced SIGKILL escalation, cancellation during real active input, and cancellation while waiting on a real flock were not independently exercised here. The supplied smoke checks cancel-before-dispatch, not those cases.
- `-t 600` bounds encoded duration. No independent wall-clock watchdog surrounds the detached encoder, so stalled X11/encoder behavior remains unverified. I have not reproduced an indefinitely stalled capture and do not treat it as a confirmed incident.
- Bounds exist on accepted video bytes, dimensions, duration, protocol output, and ffprobe output/time. Capture files remain until explicit discard, as required by the upload-before-discard contract. The new capture bytes do not enter model actions or output callbacks in the inspected adapter. No proven new private-data leak was found.
- Reviewed the supplied mutation summary and corresponding failure-log excerpts for size, clock, duration, MP4 type, and cancellation race. Those were parent evidence, not mutations rerun by this reviewer. Likewise the provided Linux smoke reports a real X11 capture, decoded frames, repeated finish, and cancel-before-dispatch; I did not rerun its Docker build.
- The parent's original full-suite failures, subsequent 40 passing Git tests, and reduced-worker full run are reported context. I did not rerun or infer completion of the parent gates. This report is not a merge or production-readiness verdict.

Recorder SHA-256 at review completion: `8d4134a599750a70dd8ee55685476267c70fdbb52f77c6c65b7f7e4312ef154d`.
