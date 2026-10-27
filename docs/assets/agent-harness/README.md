# Agent harness verification evidence

Source commit `38dd3e1f997614ec52251b8405924381378f796b`, tested tree `005c4c8442191d8fd9a1860fab4dac3fd0b770c2`, compared with base `7cd9f89b42ffd3a071a1c9831e71dc4599a9bc36`. The test snapshot `893f787d4e83f3edda6f6e211543be145fec2e2d` has exactly the source commit's tree.

The screenshots and recording render the actual `ChatTranscript`, `buildTranscript` and product CSS with generic synthetic events. They demonstrate plan updates, helper states, question options, the answer callback and replay of saved fixture events. No model, E2B, API submission, authentication or production database ran. Fixture reload uses sessionStorage. These assets do not measure agent quality or production reconnect behavior.

The base PNGs retain their original revision and hashes. Candidate captures use the source commit above, including a failed-helper state. `source-provenance.json` records source blobs; `browser-result.json` records actual browser assertions and cleanup; `video-metadata.json` records the delivered recording. The private run retains fixture source and original recordings. `artifact-manifest.json` lists the published files and hashes.

## Captures

- [answer-interaction.webm](answer-interaction.webm)
- [base-question.png](base-question.png)
- [base-working.png](base-working.png)
- [candidate-answered.png](candidate-answered.png)
- [candidate-helper-failed.png](candidate-helper-failed.png)
- [candidate-question.png](candidate-question.png)
- [candidate-reloaded.png](candidate-reloaded.png)
- [candidate-working.png](candidate-working.png)

## Checks and limits

The final required suite passed 6,381 tests across 456 files with two workers. Typecheck passed all workspace programs and the root pass. Lint and the free runtime and WebSocket smoke checks passed. The prior production web build was reused only after its production sources, configuration, dependencies and relevant import graph were confirmed unchanged.

The first four-worker full run failed the unchanged Git broker fixture's one-second startup wait before cancellation assertions. The exact test passed alone, followed by the single approved two-worker full-suite rerun. Both the initial failure and passing evidence remain in `checks/`; the precise host timing cause was not established and no unrelated source was changed.

Token admission uses estimates; delivered usage is checked and cancelled or failed model transports without final cost mark aggregate usage incomplete. Real provider behavior, exact billing, E2B persistence and remote process termination remain unexercised. The PR contains the merge-state verdict and current CI status; these files are evidence, not a claim that a real agent improved.
