# Local UI cleanup and dev-server checks

The approved test-card layout needs the approval action, expectations, result chips, recording and explicit Fix it. It does not need the generated repair prompt repeated as a job objective. The two redundant objective paragraphs and their unused CSS rule were removed. The original objective remains stored and continues to inform testing and repairs. No prose parsing, event schema or queue contract changed.

The [component regression](card-copy-red.txt) failed against the old rendering, then [all six card tests passed](card-copy-green.txt). It queries both cards by role/name and checks that assertion details and Fix it remain available. The first repeat of the complete actual UI flow with these changes [passed](native-turbopack-ui.txt).

## Dev-server failure and bounded workaround

A subsequent globals.css hot reload made the local Turbopack process return500. Its generated CSS contained replacement characters and NUL bytes in copied CSS-variable candidates that were absent from source. [Failure excerpt](hot-reload-failure.txt) renders NUL as a literal escape. Restarting restored cold compilation.

The launcher originally inherited the repository working directory. Setting the copied app directory is correct isolation, but did not eliminate this failure: a later controlled refresh with that directory also [returned500](long-lived-turbopack-refresh.json). Fresh [directory probes](cold-cwd-probes.json) and [bundler probes](cold-bundler-probes.json) returned200, so those cold results alone do not establish a repair.

The installed Tailwind/oxide is4.3.3. GitHub's release API dates that release to July16,2026. The upstream [corrupted scanner-candidate report](https://github.com/tailwindlabs/tailwindcss/issues/20368) describes a similar long-lived Turbopack failure; its [UTF-8 boundary repair](https://github.com/tailwindlabs/tailwindcss/pull/20389) merged August13. The relationship to this local failure is an inference, not a memory-safety diagnosis. No published dependency was changed or privately patched.

The local launcher uses Next's installed, supported `--webpack` dev mode and runs from the copied app directory. Normal web dev/build scripts and production behavior remain unchanged. Final native acceptance must include the complete app flow and an actual hot reload after that process has been exercised, rather than another cold probe.

## Final result

The [complete actual UI acceptance](native-webpack-ui.txt) passed under webpack in 262.71 seconds: failed Save test, real video playback/seek/range/download, explicit actual source repair, physical owner input and passing retest. [Report](report.json), [owner pixels](owner-input.png), [result view](nap-passed.png) and the [new actual MP4](failed-test.mp4) are retained. Its full strict ffmpeg decode exited0.

After that exercised process completed, a controlled globals.css edit and restoration both [returned200](long-lived-webpack-refresh.json), with exact source restoration. The [final idle screenshot](nap-ready.png) and [ready report](idle-ready.json) confirm decoded framebuffer colors, enabled owner control and testing, hidden repair instructions in both cards, and visible assertion outcomes. This establishes the bounded local workaround, not a fix in the upstream scanner. The temporary probe servers were stopped and their owned web copies removed.

[All 5,648 tests across 429 files passed](full-test.txt), along with [typecheck](typecheck.txt) and [lint](lint.txt). The independent [result-copy mutation](result-copy-mutation.txt) also failed before restoration, covering the second removed paragraph. New JSON evidence was formatted after lint caught its initial layout; no gate was bypassed. Normal hooks remain enabled. Native UI/HTTP checks used no paid service.
