# Runtime recording integration

The runtime now drains `test.started` before capture, takes annotation times from the encoder, finalizes interrupted video with a fresh cleanup context, uploads before announcing availability, and discards private capture files. Project deletion derives possible video keys from every durable test start, including uploads whose announcement failed. The owner-only media route requires that start, a later available event and the canonical key; it supports byte ranges, HEAD and explicit download responses.

Boot composes the desktop, recordings and owner input APIs. This is source wiring, not production deployment. The desktop template is still unpublished. Runtime and API tests use fakes; the separate [Linux capture evidence](../computer-recording-linux/README.md) exercises actual X11 input and ffmpeg without Chrome or E2B. Live cloud streaming, cancellation, recording transfer and playback remain pending.

## Review and repairs

The [independent review](review.md) ran 126 focused tests and found one ordering regression. A newly created workspace could start Chrome before preview readiness. The [regression failed](preview-order-red.txt) against that ordering and [passed](preview-order-green.txt) after moving preview readiness into the pre-capture callback. This test gates the real runtime path on a deferred preview response.

The review's other limitations remain explicit. Lease loss is enforced once renewal observes it, as in the existing worker design. The short gap between orphan settlement and capture cleanup can make the next recording unavailable. ObjectStore exposes whole-object reads, so each media request currently reads the bounded clip; ranged responses reduce browser transfer, not storage reads. Production rollout must publish the prepared desktop template before deploying this branch.

## Guard evidence

[Thirteen deliberate mutations failed](guard-results.txt). Re-run from an otherwise idle checkout with `bash docs/research/computer-recording-runtime/guard-mutations.sh`; it restores each source in `finally` and leaves per-case output under `/tmp/nap-recording-pipeline-mutation-*.log`. Do not run it alongside source reviewers or other checks.

Additional observed failures cover recording metadata bounds and lease loss observed after an earlier cancellation. The latter tests keep runtime cleanup pending, cancel first, then steal the lease; removing the loss latch leaves `leaseLost` false, and reading only the initial abort code incorrectly advertises a clip as available.

All new suites were confirmed with `vitest list` in their unit project. Existing event schema fixtures, PostgreSQL round trips, route authorization table, transcript folds, architecture and comment gates cover the new event and routes. No package dependency changed.

## Integrated gates

The parent full gate passed 5,514 tests across 418 files after the bounded orphan-sweep repair. Typecheck, lint, frozen install and collection checks passed. A preceding parallel run hit the existing one-second Git-helper readiness assertion; its eight isolated tests and the full serial run passed without changing a timeout. The independent recording review's preview-order finding is repaired. Cloud validation remains unapproved, and recording timing has only been tested with the fake runtime and separately with the real Linux encoder.
