# Actual Chrome desktop, local Linux evidence

This is free local evidence for the existing work in #141, #142, and #153. It does not complete their cloud acceptance. The smoke bundles the current production desktop driver, copies the current production startup, and runs actual Google Chrome Stable in a disposable Linux AMD64 Docker container. Fixture servers on ports 5173 and 5174 run inside that container. The runtime uses Docker's `--network none` and publishes no host ports.

The final positive run passed against the parent's repaired production assets at `ca61a5c`. A [follow-up probe](vnc/README.md) also authenticated Nap's installed noVNC 1.5 client against the actual server, decoded its framebuffer, and proved server-side input refusal. [Review guard repairs](guard-repairs/README.md) add strict damaged-video rejection and verified Docker cleanup. The original target-selection failure and the later DOM-truncation failure are retained below. This evidence branch leaves production unchanged, so use the source-root override to reproduce the repaired run before combining the parent repairs.

## Rerun the smoke

From the repository root, with Bun and Docker available:

```bash
bun packages/sandbox/scripts/desktop-chrome-smoke/run.ts /tmp/nap-chrome-evidence
```

Use a new or empty output directory. Omitting the path creates a unique temporary directory. The image build may download public Debian, Node, and Google packages. It never calls E2B, an image builder service, OpenRouter, a model, or Devin. The build has a 15-minute deadline. Runtime has a four-minute deadline plus a five-second forced-stop grace. Driver calls and media decoding also have deadlines. The runner attempts bounded removal of its unique container, image tag, and build directory, independently verifies absence, and fails if cleanup cannot be verified. `cleanup.json` retains all attempts and errors. It does not prune Docker resources.

To test production assets from another checkout without editing them, set `NAP_CHROME_SOURCE_ROOT`:

```bash
NAP_CHROME_SOURCE_ROOT=/Users/manasraghuwanshi/.t3/worktrees/nap/feat-computer-use \
  NAP_CHROME_EXPECTED_DRIVER_SHA256=a37b17e66de0576068bdcc44eed9b3a0b47a5f42ed7239287c9e7e3a89cd7a11 \
  bun packages/sandbox/scripts/desktop-chrome-smoke/run.ts /tmp/nap-chrome-parent-evidence
```

The install constant, driver bundle, and startup copy come from that source root. Driver bundling also uses that root as its working directory. The smoke and fixture still come from this checkout. `provenance.json` records the source root, its HEAD and dirty state, the bundled driver and startup hashes, browser package provenance, and built image metadata. Set `NAP_CHROME_EXPECTED_DRIVER_SHA256` to compare the bundle with a separately prepared artifact. A difference is recorded explicitly and printed; it is never claimed as an exact match.

The image uses Node 24 and the production `DESKTOP_INSTALL_COMMAND` dependency list. It adds curl, which startup expects from the base environment, and creates the expected `user` account. The install command creates the user-writable managed Chrome policy directory. The only normal adaptation replaces the moving Chrome download with Google's versioned Stable package and verifies SHA-256 before installation. The fixed package is `156.0.8078.47-1`, with SHA-256 `6c92cd22e90c6e3e255d782991543fa2091db8614e8536a971a7433a5c4d7ac8`. Google may eventually remove that historical package. Debian dependencies and the Node image tag can move, so this is browser provenance rather than a fully reproducible distribution snapshot.

All three TypeScript files are non-exported manual CLIs under the sandbox package's existing `scripts` typecheck include and Biome's existing file glob. No manifest or automatic test selection changes are needed. The Docker smoke is intentionally invoked separately from the free unit suite because it downloads packages and requires a Linux desktop container.

## What the smoke checks

The production startup launches Chrome at 1024×768 with the configured profile. The smoke compares its recorded PID and Linux start ticks to `/proc`, checks its actual arguments, and checks that the debugging socket inode belongs to that PID. Starting again on the same dev port must preserve that identity, the visible typed and dragged page state, and the private stream credential. A deliberately corrupted start tick must fail closed, leave Chrome alive, and recover after the record is restored.

Typing, click, scroll, drag, and address-bar navigation use the production driver and xdotool. The fixture updates visible result text only from browser input handlers. The smoke checks those results through production `read_dom`, obtains a production JPEG, and probes its actual bytes with ffprobe. Read-only CDP geometry locates fixture controls. It never uses page JavaScript to set expected state. Literal quotes, `$HOME`, backticks, and a semicolon in the typed text exercise the argv and stdin path without shell interpolation.

External navigation must show Chrome's policy-specific text, both `This page is blocked` and `Your organization`, through production `read_dom`. Changing the dev port must replace the owned Chrome process, load the new fixture, and reject the old origin with the same policy-specific error. The old fixture still answers HTTP inside the container. The current `127.0.0.1` origin must load. Network absence alone cannot pass any of these policy assertions.

A real ffmpeg recording spans the physical actions and browser replacement. Two production encoder timestamps must advance. Finish must return actual MP4 bytes with a valid header, dimensions, frame count, size, and duration matching ffprobe. ffmpeg decodes every frame with `-xerror -err_detect explode`. Repeated finish must return identical data, then discard must succeed. JPEGs and an extracted video frame are retained for visual inspection.

The base smoke checks x11vnc's actual `-viewonly` and `-localhost` arguments, serves noVNC HTML, and receives an RFB protocol banner through websockify. Those checks establish startup and the initial bridge only. The separately invoked [actual noVNC probe](vnc/README.md) establishes password rejection/authentication, decoded frames and server-side key/pointer refusal, with a writable-server negative control.

## Deliberate failures

The optional third argument injects one bounded fault into owned smoke resources:

```bash
bun packages/sandbox/scripts/desktop-chrome-smoke/run.ts /tmp/nap-chrome-red-typing typing
bun packages/sandbox/scripts/desktop-chrome-smoke/run.ts /tmp/nap-chrome-red-policy policy
bun packages/sandbox/scripts/desktop-chrome-smoke/run.ts /tmp/nap-chrome-red-dimensions dimensions
```

`typing` suppresses the fixture's visible form result. `policy` removes blocking from the temporary startup copy. `dimensions` crops the production screenshot through the production zoom action. Each run must exit nonzero. A subsequent run without a fault must pass. No fault edits production source in the checkout.

## Results and limits

`positive/report.json` records the passing run against clean parent commit `ca61a5c51ff93e53e05b44c2b57b1ccc0d269d41`. The rebuilt driver exactly matched the prepared SHA-256 `a37b17e66de0576068bdcc44eed9b3a0b47a5f42ed7239287c9e7e3a89cd7a11`. Startup also matched the prepared manifest. `positive/prepared-assets.json` records both comparisons and manifest SHA-256 `665d66118d3347df757652caa3164186482ece62b358d9d9d9c2cccf52347e81`. This validates those two desktop assets' bytes in a local image, not the entire E2B template or its publication.

The actual browser was Google Chrome 156.0.8078.47, with Node 24.22.1 and Debian's ffmpeg. Docker ran Linux AMD64 on an ARM64 host. The runtime took 64.155 seconds; preparation plus runtime and export took 74.478 seconds with cached image layers. The first uncached preparation took 334.953 seconds and is retained under `initial-build/`. These local emulated timings are not E2B latency measurements.

All JPEGs were independently probed at 1024×768. The initial, post-input, and current-origin JPEGs were 67,827, 70,103, and 67,937 bytes. Visual inspection confirmed the literal typed value, visible Applied result, scroll position of 130, yellow handle moved by 240 pixels, external and old-origin organization-blocked pages, and the allowed `127.0.0.1:5174` fixture. The extracted video frame also shows the completed input results.

The real H.264 MP4 is 428,434 bytes, 47.75 seconds, and 382 frames at 1024×768. Encoder timestamps advanced from 1,000 to 47,125 ms; the retained input frame uses source time 6,875 ms. ffmpeg decoded every frame, ffprobe confirmed actual dimensions/size/duration, repeated finish returned identical data, and discard succeeded. The websockify bridge returned `RFB 003.008` while the actual x11vnc process carried `-viewonly` and `-localhost`.

The CPU quota was `200000 100000`, or two CPUs, and memory was capped at 1,073,741,824 bytes with no swap allowance. The cgroup peak reached that configured ceiling and counted 4,589 `max` events, with zero OOM or OOM-kill events. Cgroup usage includes file cache. This run does not establish memory headroom or justify changing production allocation.

The unpatched production driver at `206c266` passed actual Chrome PID/start-tick/socket ownership, physical typing/click/scroll/drag, same-port state preservation, and deliberate stale-tick rejection. It then failed the external-policy observation. Chrome's target list placed `chrome://omnibox-popup.top-chrome/` before the actual `https://example.com/` page. Production `read_dom` selected the first `type: page` and returned the internal target's DOM. Its title and full 120,000-byte returned prefix are retained in `unpatched/last-observed-dom.txt`. `unpatched/failure-targets.json` retains the actual target ordering.

The screenshot shows the actual external page blocked by the organization. The failed smoke therefore exposed the production observer selecting the wrong page, not a successful external navigation. The parent was notified before any production repair. Production files in this worktree remain untouched. The parent repaired selection separately in `9d463a6`.

The next run used a clean parent source root at `9d463a6bfc2473f2ffe479dac963b2d462fc0e30`. Its bundled driver exactly matched the separately prepared SHA-256 `43b4452b243572503d33f1b5f9c8d45cab23654343bd1164ef2af433cf3dc139`. Selection then worked, but the full error page was 184,968 characters and production `read_dom` returned a 120,000-character prefix containing head styles and scripts, before the visible policy message. Those artifacts are retained under `truncated/`.

The original smoke oracle also expected an obsolete literal `ERR_BLOCKED_BY_ADMINISTRATOR`. Chrome 156's entire actual error DOM contains no such literal. Failure-only diagnostics and the screenshot showed the policy-specific blocked and organization text instead. The assertion was corrected to require those actual messages through production `read_dom`. Applying that corrected oracle to the retained production output also exited 1, recorded in `truncated/corrected-oracle.log`. Diagnostics never substitute for that assertion. The parent separately repaired body prioritization before the passing run.

`unpatched/failed-capture.mp4` is the real capture finalized during failure cleanup: H.264, 1024×768, 334 frames, 41.75 seconds, 200,032 bytes. Every frame decoded successfully with local ffmpeg. Visual inspection of its extracted eight-second frame confirmed the typed result, scroll position of 480, and moved yellow drag handle. The fixture was then compacted so all result labels fit fully in the desktop viewport.

`guards/dimensions/failure.json` records the intended `800 !== 1024` failure after production zoom cropped the screenshot. `guards/typing/` records the failed visible-result assertion when the fixture suppressed Applied text. `guards/policy/` uses the repaired driver but removes blocking from the temporary startup copy. Production `read_dom` then reports `ERR_INTERNET_DISCONNECTED`, with no organization-blocked message, and the smoke exits 1. This is the observed guard against confusing absent internet with policy enforcement.

The final run without faults passed again, retained under `restored/`, with the exact prepared driver hash. It took 66.082 seconds at runtime and 73.694 seconds including preparation and export. Its real capture is 437,776 bytes, 48.125 seconds, and 385 frames. Every frame decoded, and its extracted input frame was visually inspected. Cgroup peak again reached the 1-GiB ceiling. The runner removed all its containers and image tags after both the failed mutant and restored green run.

The full free suite passed 5,571 tests across 425 files with `bun run test --maxWorkers=4`. Full typecheck and lint passed. `gates/` retains the outputs, the initial unrestricted suite's unrelated 5-second app-test command timeout, its passing 26-test focused rerun, and explicit coverage of all three new TypeScript files. The manual smoke is separate from automatic test collection. The evidence commit uses the normal pre-commit hook, without bypassing gates. Issues remain open because cloud acceptance is still pending.

This minimal deterministic fixture does not establish that larger generated apps fit in 1 GiB. Local Docker does not establish E2B proxy behavior, SDK transport and output limits, template publication, owner authorization, queue fencing, cross-process cancellation, screenshot object storage, recording upload, or runtime-event alignment to video. The timestamps here come from the actual encoder, not a runtime annotation pipeline. No paid acceptance was run, no issue was closed, and no remote branch or PR was created.
