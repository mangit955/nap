# Desktop recording, local Linux evidence

The bundled desktop driver captured a 1024×768 X11 display into MP4 in a disposable Docker container. The fixture displays an X11 message window and sends physical mouse and keyboard input. The Return key closes the focused window, and the smoke checks that its process exited. It does not run Chrome, E2B, an LLM or Nap's web UI.

`report.json` records encoder time, video duration, dimensions, byte count and the container's Node version. `capture.mp4` is the actual capture. The smoke decodes every frame with ffmpeg, checks ffprobe's dimensions, repeats finish and compares its response, then cancels an input before dispatch and checks that it is refused. A second capture stalls X11 and stops the watchdog process; cleanup must leave no live encoder before discard can remove its files. `forced-report.json` records that result. The container runs without network access and is removed on exit. The first image build downloads Debian packages; it makes no paid service calls.

Run from the repository root:

```bash
bash packages/sandbox/scripts/desktop-smoke/run.sh /tmp/nap-recording-evidence
```

The controller limits capture to ten minutes, with a 610-second wall-clock watchdog and a 16 MB accepted-output ceiling, waits for a first encoded frame, and reads annotation time from ffmpeg's `out_time_us`. Process identity includes Linux start ticks so cleanup does not signal a reused PID. The encoder stops at 14 MB to leave room for final packets and MP4 indexes. The busy-video check accepted 14,161,384 bytes and decoded all 573 frames; `headroom.json` records it. Run `bun packages/sandbox/scripts/desktop-smoke/check-headroom.ts` to repeat that free check with local ffmpeg. Finish drains the encoder and validates MP4 size, type, dimensions and duration. The runtime must upload the returned video before discarding its private temporary files.

Free tests also reject malformed base64 without overflowing the regex stack at the maximum recording size and stop encoders when metadata persistence fails. Free tests cover lifecycle, sandbox isolation, explicit failures, capture cancellation, duplicate finish, malformed output and cancellation while input waits for dispatch. Deliberate mutations of the size limit, encoder clock conversion, positive duration, MP4 type and cancellation race check were each observed failing, then restored.

This evidence does not establish production template publication, E2B exec output limits for large videos, recording upload/deletion, owner media authorization, VNC streaming or the integrated recording viewer. Those remain separate acceptance steps. The container uses Node 20; the production template installs Node 24.

Three review rounds are retained here. Four confirmed lifecycle/cleanup findings were repaired; the final bounded repair review found no actionable regressions. Final free gates passed 5,213 tests across 403 files with four workers, typecheck and lint. The earlier unrestricted run's unrelated Git/UI timeouts remain in the working evidence. The focused Git rerun and subsequent full runs passed without timeout changes or skipped tests.
