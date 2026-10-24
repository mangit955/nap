# ADR-0018 — The agent gets a computer

**Status:** Approved design, implementation draft — 2026-10-24. The paid spike in [#138](https://github.com/mangit955/nap/issues/138) has not run. Sandbox sizing and image forwarding through OpenRouter remain unmeasured. Final acceptance belongs to [#140](https://github.com/mangit955/nap/issues/140).

## Context

Nap's agent can edit and run a project but cannot see or operate its UI. The existing preview is a human-facing iframe. Deterministic verification runs sandbox commands and a preview probe. NapBench drives its own external browser to evaluate Nap. These mechanisms answer different questions.

The user approved a project desktop, a batched `computer` tool, and a source-grounded test turn that leaves screenshots and annotated recordings for review. The UI follows Devin's Computer view and recording workflow using Nap's components, copy conventions, and tokens. The [primary-source research](../research/devin-browser-primary-sources.md) separates documented behavior from inference. [Passive live reference and themed mockup evidence](../assets/computer-use/review/README.md) records what was actually observed.

This changes the six-tools invariant in `CLAUDE.md`, `docs/PLAN.md` §0, and the `TOOL_NAMES` documentation. It also changes ADR-0001's assumption that only NapBench needs browser interaction. It preserves ADR-0007's dependency boundary: production code never imports `@nap/bench`. The computer is an agent capability, not NapBench's evaluator.

## Decisions

### D1: Put the desktop inside the project sandbox

Layer Xvfb at 1024×768, a small window manager, Chrome, xdotool, ffmpeg, x11vnc, and websockify/noVNC onto the existing E2B template. Start the desktop lazily on first use. Keep the dev server and the browser on the same project machine. Idempotent startup must converge after a retry without creating duplicate displays or browsers.

The paid spike must measure Chrome plus Vite memory, cold-start time and cost, screenshot latency, and JPEG size. Do not change sandbox resources or deployment sizing from an estimate. Publishing a template and running a real sandbox require separate user approval.

### D2: Keep desktop operations behind a separate port

`SandboxDesktop` owns start, screenshot, actions, and stream credentials. It does not create sandboxes, manage git, admit turns, or store objects. `SandboxManager` retains lifecycle, files, commands, and preview ownership. The E2B desktop adapter runs commands through the existing exec capability. It does not add `@e2b/desktop`, whose E2B requirement conflicts with the pinned version. A production-quality fake supports the same observable action ordering and failures.

### D3: Batch actions and return one final screenshot

Offer one `computer` tool with `actions`. The vocabulary is `screenshot`, `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `mouse_move`, `left_click_drag`, `left_mouse_down`, `left_mouse_up`, `cursor_position`, `key`, `hold_key`, `type`, `scroll`, `wait`, and `zoom`. Add read-only `read_dom` and `console` observations, plus `annotate` for test evidence.

Validate all coordinates and regions against the screen, and bound waits and scroll input at the tool boundary before executing any action. Execute actions in order, then take one screenshot for the tool result. Keep a failed call paired with its error result. No `javascript` action is offered. Desktop execution belongs in the adapter; the agent owns tool validation and typed event emission.

### D4: Store screenshots as objects and return images to the model

Store JPEG bytes through `ObjectStore`. `computer.screenshot` carries `toolCallId`, `key`, `width`, and `height`, never image bytes. Publish the reference only after its object exists. Persist tool results as text with separate screenshot events; resolve images only for the active model turn.

Widen `LLMContentBlock` so a tool result accepts text/image blocks as well as the existing string. Map nested image blocks to the installed Anthropic SDK shape. Free request-shape tests cannot establish OpenRouter forwarding. The spike must exercise an image inside a `tool_result` for Sonnet 5 and Opus 5 before the transport is called validated.

The storage ticket must select a durable screenshot key index. `ObjectStore` cannot list keys. Deleting a project must delete objects before discarding their only index, retain retryability on failure, and enforce ownership on every image request. The choice between event-derived keys and a table is still open in [#145](https://github.com/mangit955/nap/issues/145).

### D5: Keep three screenshots within a turn

Only the three newest computer screenshots in the current turn remain image blocks. Replace older ones with an explicit text marker, preserving every tool-use/result ID and pair. Screenshots from earlier turns are never replayed, extending ADR-0011. User-supplied media from ADR-0015 retains its own policy.

Account for nested images at the existing local image estimate. Apply pruning before budget checks, including compaction and historical restoration paths. Several-budget tests must demonstrate no orphaned calls in either direction.

### D6: Gate the capability and budget test turns separately

Offer `computer` only when `modelSupportsImages(model)` permits image input. An unknown model is text-only. Test turns use their own step and token budget rather than raising the normal turn's limits. A separately selected test model is later work and still needs model access and billing policy at admission.

### D7: Default Chrome to the project's dev server

Use Chrome's URL policy to allow the project's own dev server and block other navigation. The default is approved. Loosening that policy per project is later work. This is a browser navigation policy, not a claim that the sandbox has no network or that a command-capable agent cannot access the network through another tool.

### D8: Start app testing from a system-built prompt

After a verified job, offer **Test the app**. Its click queues a turn with prompt source `test`. The system builds the prompt from the diff and the job goal, following the repair-prompt pattern. It asks for a focused plan grounded in source and the primary flow, followed by visible actions.

The system prompt retains its deliberate omission of verification instructions. The existing `/\bverif/i` guard remains. Test planning belongs in the test prompt builder, not a permanent paragraph sent on every build step. Queue ownership, admission, billing, cancellation, and terminal events remain the ordinary turn machinery's responsibility.

### D9: Make assertions data and repair an explicit choice

`annotate` records `setup`, `test_start`, `action`, and `assertion`. Assertions carry an expectation stated before the action and a result of `passed`, `failed`, or `untested`. An unexecuted assertion is never a pass. Recording timestamps use the capture's source timeline.

A failed assertion offers **Fix it**. Only that explicit click queues a normal repair turn. Test failure never starts repair automatically and never changes the deterministic verification checkpoint into an agent-reported pass. The manual repair choice is approved.

### D10: Use VNC and allow human input only while idle

Use noVNC through E2B's port proxy. An owner-only API route supplies address and password with private, non-cacheable responses. Credentials never enter the event log, transcript, object keys, or logs. The client starts view-only and releases resources on disconnect or unmount.

**Take control of Nap's computer** is allowed only when `TurnQueue.anyLeased` reports no running turn across the project's sessions. The server enforces the decision. A visible running-turn reason accompanies the disabled control. Input uses X11 keysyms. Pausing an active turn is later work. The implementation must also prevent a queued turn beginning from leaving an older takeover connection writable.

### D11: Follow Devin's UI in Nap's theme

Add a Computer tab beside Browser, Files, Diff, and Pull requests. Center and letterbox the 1024×768 desktop. The screen has role `application` and name **Remote computer**. Use the approved copy and accessible names from [the UI ticket map](https://github.com/mangit955/nap/issues/137).

The floating control strip contains Session timeline, Previous event, Next event, Live or Go to live desktop, Stream quality with Auto/Sharp/Data saver, Full screen, and pop-out. There is no audio control. Match waiting, desktop-starting, connecting, failed/retry, and missing-history states. Takeover adds the touch-keyboard textbox and the accent rim. Work-log rows omit typed values and seek to their screenshot. Transcript screenshot cards open the corresponding frame.

Use the composer's glass recipe: panel at 80% in sRGB, 16px blur with 1.08 saturation, the existing inset highlight, 16–24px radii, and solid fallback both without backdrop-filter and under reduced transparency. Blur only the control strip over the frame. Use Nap color/status/shadow tokens and the existing `rim-glow`, `lit-box`, `use-pulse`, and elapsed timer.

Test approval/results use glass cards, status chips, Watch recording, and explicit Fix it. The recording viewer has a counts header, Setup/Test chapter rail, expectations and results, Space playback, Shift+Arrow chapters, chapter looping, speed, fullscreen, download, and accessible Close. DOM replay controls are later work. Each shipped UI ticket needs its own matching passive reference capture and Nap evidence; the standalone mockup is design evidence only.

## Alternatives and limits

A separate desktop service would create a second machine lifecycle and separate project files from the browser. `@e2b/desktop` would force an unrelated E2B upgrade. Browser automation inside the API process would put untrusted app execution beside API credentials. WebTransport and WebCodecs match Devin's primary stream more closely but add a custom streaming protocol before VNC has been measured. These options are excluded from this milestone.

Source-code inspection between visible actions is useful; arbitrary JavaScript that forces the expected state would weaken test evidence. `read_dom` and `console` remain observations. Guarded JavaScript needs a later explicit policy. Saved profiles, secret typing, edited videos, test-specific models, DOM replay, and per-project navigation policy are separate backlog issues.

A video and agent-reported assertions show what was attempted. They do not prove exhaustive coverage or comparative model reliability. NapBench must independently grade planted-bug and correct-code tasks without importing the production assertions as an evaluator.

## Rollout and remaining evidence

The implementation is tracked in [map #137](https://github.com/mangit955/nap/issues/137). Free fakes and screenshot history come first. New strict event readers, worker support, and authenticated media routes must deploy before any producer emits the new event types. Existing sessions must remain readable. New fields on existing payloads need defaults that describe historical rows.

The tool enum, runtime seam, and public mechanism docs include the image-gated computer capability. Free tests compose a fake desktop; production boot does not yet compose a desktop adapter. The template still needs its desktop layer. The paid spike finalizes this ADR; the template build and live desktop require another approved paid step. `docs/DEPLOY.md` changes only if measured sandbox sizing or required production configuration changes.
