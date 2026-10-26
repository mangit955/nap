# Authenticated local app acceptance

This check connects the actual Nap UI, owner authentication, Postgres project guard and turn queue, Docker SandboxManager, production desktop adapter/driver, noVNC client, runtime test mode, real ffmpeg video, RAM ObjectStore, owner media route and recording viewer. The provider follows the labeled Notes scenario. No E2B or model request is made.

The fresh image is `nap-local-sandbox:ff6cb6dd390bf1edeb4a5d02`. Its desktop driver is SHA-256 `6f7201ab69002d4f840f4fb226b8c7d28e826bde8478d7c6cddbad92dac80c07`, identical to the newly prepared unpublished production asset. Local Docker uses 2 CPUs and 2 GiB. This does not establish headroom for the unchanged 1-GiB production template.

## Native result

The authenticated browser check passed in 232.79 seconds. [Report](report.json) and [Vitest output](native-ui.txt) record the result. It proved the first live connection, anonymous401, leased input409, stale-grant409, failed assertion, actual video playback and seeking, byte-range206, identical download, real source repair and passing retest. The [owner framebuffer](owner-input.png) visibly contains OwnerInputProof after physical guarded mouse/keyboard input; the independent production read_dom observation also found that saved list item. [Final workspace](nap-passed.png) shows the passing test, captured just before queue settlement. The [final idle workspace](nap-ready.png) and [ready-state report](idle-ready.json) separately confirm the settled queue, decoded live frame, enabled Take control and enabled Test the app. The first readiness screenshot was taken before decoded pixels arrived; the replacement waits for sampled framebuffer colors, rather than trusting canvas existence.

The [actual failed-test video](failed-test.mp4) is 352,663 bytes, SHA-256 `615abe56543e7152c471a6b799a4eb20e9b8e8e3e44e01b5ee4e083bd07a2601`, 1024×768, 679 frames and 84.875 seconds. A full strict decode with `ffmpeg -v error -xerror -err_detect explode` exited0. [Metadata](video-metadata.json) and [decoder output](strict-decode.txt) are retained. The reviewer inspected the decoded failed-save frame and the owner-input framebuffer. The assertions are produced by a deterministic scripted provider, so this establishes integration rather than model capability.

## Repairs exposed by actual use

- Repeated identical source setup produced an unverified job because it created no new checkpoint. The acceptance harness now requires a freshly seeded launcher. The old failure is retained in `fresh-checkpoint-harness-failure.txt`.
- Physical owner input moved the pointer, then clicked the same coordinates. The installed xdotool stalled on `mousemove --sync` at the current position: the native command timed out after two seconds, while ordinary mousemove completed. The driver now chains ordinary movement and click. The unit regression was observed failing before the repair. The final native path must prove the note appears through real DOM and decoded noVNC pixels.
- Real lazy startup exceeded Bun's ten-second HTTP idle default. A real Bun listener plus external curl reproduces the dropped response with `--default`; the shared 120-second server option retains it. The desktop execution bounds remain unchanged.
- Navigation and Strict Mode abandoned stream requests while their desktop starts still occupied the action lock. The route now forwards request cancellation and refuses credential acquisition after an aborted start. The regression and separate post-start guard mutation fail before their respective repairs. `cold-stream-failure.txt` preserves the preceding native failure.

Rapid diagnosis used a temporary driver replacement and then a credential-free operation tracer in an earlier owned container. Those runs are not immutable-image acceptance. That container was stopped and removed. The final UI run uses a fresh container from the rebuilt image without either replacement.

## Scope and gates

The opt-in browser test is `apps/napbench/src/computer-local.integration.test.ts`. Its collection appears in `integration-collection.txt`; helper and driver regressions appear in `unit-collection.txt`. API scripts and napbench source enter their existing workspace tsconfigs. Biome, architecture, comments, hooks and test-project globs remain enabled. The occupied-port guard was observed rejecting a second launcher before allocating resources.

Actual cloud proxy behavior, E2B SDK cancellation/output sizes, production memory headroom, live cross-worker cancellation, missing passive Devin reference states, and real-model capability trials remain outside this local proof. Existing unit and PostgreSQL tests cover additional owner, lease, recording failure and cancellation cases; do not infer that every failure case was driven through this native UI run.

## Repository result

The first [full free suite](full-test.txt) passed 5,647 tests in 429 files. The [final cleanup gate](ui-cleanup/full-test.txt) passed all 5,648 tests. [Typecheck](typecheck.txt) and [lint](lint.txt) passed; lint retained its existing warning/info. Normal commit hooks remain enabled. The new HTTP and stream cancellation checks, same-position mouse regression, web-copy guards and occupied-port refusal were observed failing under their corresponding faults. No test timeout, glob, production invariant or CI exclusion was weakened.

Earlier owned local runs shut down with cleanup.ok true and their exact containers were absent afterward. The accepted app instance remains running for interactive use; shared image caches and pre-existing databases are retained. The old demo listeners were already absent at the final local-manager handoff, so this report does not claim their current availability.

The generated repair objective repeated in both cards was removed in the [UI cleanup](ui-cleanup/README.md). Assertions remain visible and backend test/repair data remains intact. Matching passive reference states and paid cloud acceptance remain open.
