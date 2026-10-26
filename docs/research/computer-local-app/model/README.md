# Scripted local Notes provider

The local-only provider implements `LLMProvider` with zero token usage and no vendor client. The exports are `computerLocalProvider(delayMs = 350)` and `computerLocalAppSource("buggy" | "fixed")`. The provider emits only existing `read_file`, `write_file`, and `computer` tool calls.

## Source flow

A normal `Build Notes` turn reads `/home/user/app/src/App.tsx`, then writes the buggy Notes source to that same file. Save clears the input but leaves the saved list unchanged. A new normal turn whose current request is `Fix it`, or the actual `appTestRepairPrompt` beginning `Fix the failures found while testing this app.`, writes the fixed source after reading the file. Older repair prompts and the number of earlier edit turns do not select the fixed version.

Both versions come from `computerLocalAppSource`. Their sole difference is the save handler's state update. The fixture helper gives the parent the same source for acceptance checks; it does not create a second served app. The normal runtime owns source writes through its tools, Git, project checks, and checkpoints. Provider messages do not assert that those checks passed.

The source has no external assets or requests. It keeps notes in React state until refresh and displays `Scripted local demo` in a fixed badge. The parent composition must disclose the scripted model in the project name and launcher. The existing image-capable ID is `anthropic/claude-sonnet-5`; selecting that ID for the scripted provider makes no model call.

## Test flow

Test tool availability selects the computer-only path. It never writes source, runs commands, executes JavaScript, or initiates repair.

1. Annotate setup. Use `ctrl+l`, type `http://localhost:5173/`, press `Return`, wait one second, and return a screenshot.
2. After receiving that screenshot, annotate chapter `save-note`, assertion `save` with result `untested`, and the action description. The stable expectation is `The saved note appears in the list.`
3. Click input `[448, 400]`, press `ctrl+a`, type a fresh `Note` plus UUID with alphanumeric characters, click Save `[744, 400]`, wait 0.3 seconds, and return a screenshot.
4. After receiving the input screenshot, issue a separate `read_dom` computer call.
5. In a later model step, match exactly one ordered assistant tool use and successful user tool result for that call's unique ID, name, and input. Find the app marker and one complete saved list in its text. Pass only for `<li data-testid="saved-note">CURRENT_UNIQUE_NOTE</li>` inside that list. A complete list without the current note fails. Missing, failed, stale, duplicate, mismatched, or incomplete observations leave the original assertion untested.
6. Annotate a tested verdict using the original assertion ID and expectation. Finish without repair. The owner can explicitly request Fix it in a normal turn.

The source places the controls at CSS y212–340 and x224–672 for input, x688–800 for Save at width1024. The parent corrected the scripted clicks to y400. This lies inside the source-derived row for both the observed 145px Chrome content offset and an 85px offset. The original y330 missed the row when Chrome showed its unsupported-flag banner. The parent owns live calibration on the actual 1024×768 desktop and integrated source, browser, recording, and repair acceptance.

Stable DOM markers are `notes-app`, `note-input`, `save-note`, `saved-notes`, and `saved-note`. Tool IDs and typed note text are unique per turn. Earlier turns' tool exchanges cannot supply a verdict for the current turn.

## Verification boundary

The focused tests assert tool order, actual fixture source, observation identity, annotation events accepted by `AppTestRun`, cancellation, and typed errors. The generated React strings still require the parent's real template typecheck and Vite build after merge. Unit success does not establish browser appearance, live coordinates, Docker execution, auth, media capture, or integrated acceptance.

The suites are collected by the existing unit glob. `apps/api/tsconfig.json` already includes `scripts`, so the four TypeScript files enter typecheck, Biome, and the normal pre-commit hooks. No config or dependency change is needed. The local work creates no app server and changes no existing demo or database.

[Evidence](evidence.txt) records the actual RED runs, guard mutations, and final gate summaries. Full temporary logs remain under `/tmp/nap-local-model-*.log` and `/tmp/nap-local-model-mutations-final/` in this implementation environment.

The rerunnable guard check is `node docs/research/computer-local-app/model/mutate.mjs`. It runs each focused mutation with one worker, saves its actual failure log, and restores the source in `finally`. Run it separately from other checks because it temporarily mutates source. Its first run found a surviving use-count mutation; the regression now duplicates only the use, preserving exactly one result, and catches that mutation.
