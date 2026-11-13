# Preview pane evidence

Before component: `4de3797ae606cba50639cd65c2e7e14c306091b4`.
After component: snapshot `debc9171b195269a78a82c198dcfb743819241f9`.
Exact component source SHA256 values are in `fixture-source-map.json`.

`lifecycle.mp4` is a continuous T3 preview browser recording, 104.49 seconds, with actual base and candidate components side by side. The fake iframe server waits 2.5 seconds per response. Controls drive startup, ready announcements, reload and route. This is local fake evidence, not a paid E2B restore benchmark. The startup thumbnail is a deterministic SVG stand-in for a saved app picture.

`startup-comparison.png` shows both versions in startup after a client transition. The candidate labels and dims its saved snapshot. `loaded-comparison.png` shows both versions after app version 2 loaded. The original full recording is preserved locally. No timing normalization or synthetic video frames were introduced.

The proof route and base component copy were temporary, removed by the supervisor. Run `browser-supervisor.py` from the repository root from a checkout of the published feature head. The supervisor reads the candidate component from `HEAD` and verifies its SHA256 against the recorded source, so the local-only snapshot object is not required. The historical base object is reachable from the feature history. It writes only its owned temporary route/base component, launches Next on 4598 and the fake app server on 4599, and cleans up after 240 seconds or a `browser-stop` file beside the script. Use the gods-hand shared resource runner. Remove a previous `browser-stop` before reuse. This fixture and its CSS come from the repository; the feature PR does not add a demo route.

`checks.txt` contains real output excerpts; local full logs retain exact argv, cwd, SHA, environment, exit and deadlines. Mutation diffs correspond to removing the onLoad gate, timeout fallback, thumbnail project scope and frame cap. Each failed its matching test and was restored before green verification.

## Reproduce the fixture

The original capture used the T3 preview browser on macOS, the repository's installed Next/React/Tailwind versions, and the fake server in `browser-supervisor.py`. Download this evidence directory outside the checkout, then from the repository root run the supervisor under the shared runner:

```sh
python3 /path/to/gods-hand/scripts/run_check.py --timeout 300 -- python3 /path/to/evidence/browser-supervisor.py
```

Open `http://localhost:4598/gods-hand-proof`. Click Starting after hydration to match the client-fetched project path, then Ready version 1, Ready version 2, Reload and Change route. Allow each 2.5-second response to load before the next operation. Touch `/path/to/evidence/browser-stop` to stop early. The supervisor removes only its temporary route and base-component copy. This command is a reproduction instruction, not an additional run claimed by the verification record.

## Still-image provenance

`startup-settled-comparison.png` is the first decoded frame of `lifecycle.mp4` at presentation time at least60 seconds. It shows the settled snapshot backdrop, unlike the earlier startup image captured at the beginning of its opacity transition. Bounded single-thread FFmpeg extraction preserved the original frame. The MP4 is a continuous browser recording, but sampled extraction did not identify a reliable ready-overlap still; do not label the loaded comparison as overlap evidence.

## Final pending replacement capture

`ready-overlap-comparison.png` is a fresh actual browser screenshot from the final integration tree, about503ms after Ready version2. The left base iframe is white while its server answers; the right candidate retains App version1 with its Updating label. `ready-dom-proof.json` records the real DOM at that time, including the hidden incoming iframe and the old iframe's `inert` and `aria-hidden` attributes. The test page contains three iframes total because it renders both panes side by side: one base frame and two candidate frames.

`ready-overlap.mp4` uses50 actual Chrome CDP screencast JPEG frames over4.8998seconds, preserving their recorded timestamp differences. The encoder adds one black padding row for an even H.264 height. No frame was synthesized or UI state mocked. The fixture's labels name the recorded component snapshots, whose bytes match the final integration candidate/base as documented in the source map. This video demonstrates pending replacement, not completion of the handoff; `lifecycle.mp4` is retained for the wider state sequence.

The shared T3 preview browser failed twice with: "The browser is not producing screenshot frames. For a desktop tab, show or restore the T3 Code window and try again." The approved browser fallback used headless installed Chrome via the repository's Playwright/CDP library, under the same bounded resource runner. The temporary route, base copy and browser were removed at the end.

To reproduce the narrow ready capture, use the same resource runner command with `headless-ready-supervisor.py`. The driver waits for App version1 to load in both panes, records one Ready version2 request, captures its real pending DOM/screenshot500ms later, and stops within20seconds of capture. It does not wait for or assert successful takeover. This documented reproduction entrypoint was adjusted to portable checkout paths after the actual run; it is not an additional execution claim.

`ready-final-capture.png` is simply the final screenshot taken by the narrow driver. Its neutral name does not assert that `load` or timeout takeover was observed. The original DOM sample label `loaded` was a hard-coded expectation in that driver, not a state detector. The actual sample at6000.4ms still shows pending replacement; Ready2 occurred at1001.8ms, so the sample was only4998.6ms after that request, just before the five-second fallback could expire. This recording/DOM log establishes the pending state and stale-frame accessibility handling. It does not establish which later load/fallback completed the handoff or explain the incoming fake navigation's delay. The component load and timeout tests provide separate behavioral evidence. The public reproduction driver now uses the neutral time label `sample6000`; recorded raw sample values remain unchanged.
