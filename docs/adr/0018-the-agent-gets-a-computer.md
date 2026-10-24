# ADR-0018 — The agent gets a computer

**Status:** Accepted, 2026-10-24. The [paid spike](https://github.com/mangit955/nap/issues/138) measured the desktop and confirmed nested screenshot reading on Sonnet 5 and Opus 5. [Measured evidence and limits](../research/computer-use-spike/README.md) includes the first failed policy and the corrected run. Acceptance records the design; remaining implementation is tracked in [map #137](https://github.com/mangit955/nap/issues/137).

## Context

Nap's agent can edit and run a project but cannot see or operate its UI. The existing preview is a human-facing iframe. Deterministic verification runs sandbox commands and a preview probe. NapBench drives its own external browser to evaluate Nap. These mechanisms answer different questions.

The user approved a project desktop, a batched `computer` tool, and a source-grounded test turn that leaves screenshots and annotated recordings for review. The UI follows Devin's Computer view and recording workflow using Nap's components, copy conventions, and tokens. The [primary-source research](../research/devin-browser-primary-sources.md) separates documented behavior from inference. [Passive live reference and themed mockup evidence](../assets/computer-use/review/README.md) records what was actually observed.

This changes the six-tools invariant in `CLAUDE.md`, `docs/PLAN.md` §0, and the `TOOL_NAMES` documentation. It also changes ADR-0001's assumption that only NapBench needs browser interaction. It preserves ADR-0007's dependency boundary: production code never imports `@nap/bench`. The computer is an agent capability, not NapBench's evaluator.

## Decisions

### D1: Put the desktop inside the project sandbox

Layer Xvfb at 1024×768, a small window manager, Chrome, xdotool, ffmpeg, x11vnc, and websockify/noVNC onto the existing E2B template. Start the desktop lazily on first use. Keep the dev server and the browser on the same project machine. Idempotent startup must converge after a retry without creating duplicate displays or browsers.

The paid spike measured Chrome plus Vite memory, cold start, screenshot latency and JPEG size on the existing 1-GiB allocation. Keep that allocation for the initial desktop layer; the minimal fixture is not evidence that heavier apps fit. No deployment-size change follows from this measurement. Publishing the production template and later real sandbox/model runs require separate user approval.

### D2: Keep desktop operations behind a separate port

`SandboxDesktop` owns start, screenshot, actions, and stream credentials. It does not create sandboxes, manage git, admit turns, or store objects. `SandboxManager` retains lifecycle, files, commands, and preview ownership. The E2B desktop adapter runs commands through the existing exec capability. It does not add `@e2b/desktop`, whose E2B requirement conflicts with the pinned version. A production-quality fake supports the same observable action ordering and failures.

### D3: Batch actions and return one final screenshot

Offer one `computer` tool with `actions`. The vocabulary is `screenshot`, `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `mouse_move`, `left_click_drag`, `left_mouse_down`, `left_mouse_up`, `cursor_position`, `key`, `hold_key`, `type`, `scroll`, `wait`, and `zoom`. Add read-only `read_dom` and `console` observations, plus `annotate` for test evidence.

Validate all coordinates and regions against the screen, and bound waits and scroll input at the tool boundary before executing any action. Execute actions in order, then take one screenshot for the tool result. Keep a failed call paired with its error result. No `javascript` action is offered. Desktop execution belongs in the adapter; the agent owns tool validation and typed event emission.

### D4: Store screenshots as objects and return images to the model

Store JPEG bytes through `ObjectStore`. `computer.screenshot` carries `toolCallId`, `key`, `width`, and `height`, never image bytes. Publish the reference only after its object exists. Persist tool results as text with separate screenshot events; resolve images only for the active model turn.

Widen `LLMContentBlock` so a tool result accepts text/image blocks as well as the existing string. Map nested image blocks to the installed Anthropic SDK shape. Free request-shape tests cannot establish OpenRouter forwarding. The spike exercised an image inside a `tool_result` for both Sonnet 5 and Opus 5. Both correctly reported a random marker that appeared only in the checked JPEG, using the production request mapper and a forced structured tool response.

The storage ticket must select a durable screenshot key index. `ObjectStore` cannot list keys. Deleting a project must delete objects before discarding their only index, retain retryability on failure, and enforce ownership on every image request. Use deterministic project/session/turn/call keys derived from durable `tool.call` events. The runtime drains the call before upload. That event reserves the object key even when the later screenshot announcement never becomes durable, so project deletion can remove partial uploads without a bucket listing. Screenshot events provide dimensions and history. Deletion reads every project session before removing objects and keeps those events if any read or delete fails. This uses the existing event index rather than a table that would duplicate the call identity. The owner-only route accepts a screenshot sequence and checks its key against the same derived identity. Its non-cacheable JPEG response never accepts an arbitrary object key from the request.

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

The queue stores an approved job ID as a `test` request and applies the ordinary lease, model access, billing and limits. Runtime rechecks that it is the latest verified job, HEAD still matches its checkpoint, and the worktree is clean. The diff spans the parent of the job’s first committed turn through its checkpoint, including repairs. `test.started` records goal and commit; the generated diff prompt is not a protected historical user request. Test turns can read source and use the computer, with a separate budget; source edits and commands are refused at execution as well as omitted from the offered tools. They make no commit and do not enter the repair loop.

### D9: Make assertions data and repair an explicit choice

`annotate` records `setup`, `test_start`, `action`, and `assertion`. Assertions carry an expectation stated before the action and a result of `passed`, `failed`, or `untested`. An unexecuted assertion is never a pass. Recording timestamps use the capture's source timeline.

The ledger requires a declaration with result `untested`, input after that declaration, and a later stored screenshot before a matching assertion receives a verdict. Assertion IDs and expectations cannot change between declaration and result. Interrupted tests preserve their assertion data and need an explicit rerun.

A failed assertion offers **Fix it**. Only that explicit click queues a normal repair turn. Test failure never starts repair automatically and never changes the deterministic verification checkpoint into an agent-reported pass. The manual repair choice is approved.

### D10: Use VNC and allow human input only while idle

Use noVNC through E2B's port proxy. An owner-only API route supplies address and password with private, non-cacheable responses. Credentials never enter the event log, transcript, object keys, or logs. The VNC server remains view-only and the client releases resources on disconnect or unmount. Human input goes through owner-authenticated API actions, not a writable VNC connection. Short input dispatch and queue claims share a project guard so no turn can become leased while a human input is being applied. The guard uses the existing authoritative busy predicate; it is not held across an entire turn or recording.

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

The tool enum, runtime seam, and public mechanism docs include the image-gated computer capability. Free tests compose a fake desktop. Production boot now composes the exec-based desktop/capture adapter and owner routes; the desktop template layer is prepared locally but has not been published. The paid spike has finalized the measured parts of this ADR. Production template publication and real integrated streaming/control/recording checks require another approved paid step. `docs/DEPLOY.md` changes only if measured sandbox sizing or required production configuration changes.

The implementation sketch compared a sandbox command controller with direct E2B SDK process/file handles. Keep the approved exec boundary. A small sandbox-installed CLI owns physical commands and capture files; fixed read-only CDP operations provide DOM and console observations. Reject a detached dispatch supervisor, operation replay journal, broad control state machine and second recording index until a measured limitation requires them. Input is never automatically replayed after an ambiguous failure. `SandboxRecordings` owns capture processes and encoder timestamps separately from agent input. Runtime owns upload and recording events. The existing drained `test.started` event reserves a possible video key before capture, including when no later recording announcement becomes durable. Derive that key during project deletion; old tests with no video simply delete an absent key successfully. This reuses the test identity and avoids a second reservation event or table. An available recording event is required for playback; the owner route also checks the earlier test start and the derived key.

Annotation times come from encoder progress while capture is healthy. Losing that clock makes the video unavailable while retaining assertions. Capture finalization uses a fresh cleanup context after user cancellation. Once a worker observes lease loss, it cannot announce a video as available, including when the loss is observed during upload. This follows the existing renewal boundary; it does not add transaction fencing to object uploads. The janitor discards abandoned private captures and closes their recording state without replaying a test. Whole computer turns release held pointer input while they still own their lease.
