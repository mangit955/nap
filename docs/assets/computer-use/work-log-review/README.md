# Computer work log evidence

The real `ChatTranscript`, `WorkEntryRow`, screenshot card, and `ComputerPane` share a selected event in the test-only `ComputerReview` fixture. These are application components, not the standalone mockup.

`nap-work-log-expanded.png` shows two action labels, an inline screenshot, and the Computer pane at their frame. `nap-screenshot-seek.png` follows a return to live and a click on the screenshot card. `nap-work-log-phone.png` covers 390px without horizontal overflow. The browser asserts both navigation paths select event 3, typed values never appear in the document, and images request credentials. It fails on runtime exceptions. Native full screen and the remaining Computer states are covered by the [panel review](../panel-review/README.md).

`devin-reference.png` was captured passively from the user's already-open session at 2026-10-24T02:57:42.583Z, Chrome 153, 2400×1584. REA captured the visible viewport only. No click, typing, navigation, scrolling, or script evaluation was sent to that browser. It shows inline screenshot cards and a disconnected Computer view reading “Reconnecting…”. Compare the cards with Nap's expanded capture and the disconnected view with [Nap's failed connection capture](../panel-review/nap-computer-failed.png). The approved Nap wording is “Failed to connect to Nap's computer” with Retry. There is no passive reference for expanded action rows yet. The test recording viewer also remains uncaptured.

Nap desktop captures are 1440×1100; the phone capture is 390×1100. Screenshots were inspected after the scripted checks passed. `fixture-desktop.jpg` is Nap's own synthetic sign-in mockup; no Devin assets are used by application code. All image requests are fulfilled locally by the review script. This evidence proves UI interaction, not a live desktop, cookies against a real API, or model behavior.

## Reproduce

Follow the servers, dedicated Chrome, and temporary Next route instructions in the [panel review](../panel-review/README.md), then run:

```sh
node docs/assets/computer-use/work-log-review/check.mjs
```

The script refuses Devin's passive port 9223, uses its own tab on port 9337, and closes that tab afterward. Remove the temporary review route before committing.

Action-label and component suites were observed failing before implementation. They cover all current actions, reject malformed/oversized recorded input, keep typed values out of labels, attach interleaved events by tool-call ID, handle replay without an earlier call, count actions across batches, and remove the startup timer when ready. Recording-start/stop rows need the later recording event producer; recording is not a computer action.

Integration review: these sources and tests are inside existing web TypeScript, Biome, and Vitest unit/web globs, with no dependency or architecture change. The fixture and screenshot script use fake events and local images. The application continues using its single session-log subscription. CLAUDE.md, PLAN.md, and PROGRESS.md require no further invariant changes for this presentation work.

The deliberate mutation changed the type label to return its input text and raised the recorded batch cap to 33. Three tests failed, including the rendered action row; the source was restored. Final full gates passed: 5,076 tests in 382 files, typecheck, lint, and production build. The existing stylesheet specificity warning remains unchanged.
