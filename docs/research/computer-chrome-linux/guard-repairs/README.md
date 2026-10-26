# Smoke guard repair evidence

The independent review of local commit `2f85e90` found two harness defects. All retained historical media decoded cleanly during that review. The defects affected future enforcement.

Run the bounded regression CLI:

```bash
node docs/research/computer-chrome-linux/check-harness-guards.mjs /tmp/nap-harness-guards
```

The decoder check damages one indexed H.264 packet at 30 seconds in a temporary copy of the committed positive capture. It zeros 9,671 bytes at offset 175,527 while preserving the file length and MP4 index. ffprobe still reports the original codec, dimensions, indexed frame count, duration, and byte size. The old command exits 0 while printing invalid-NAL and decoder errors. The strict command uses `-xerror -err_detect explode`, exits 183 on the damaged file, and exits 0 with no error output on the original capture. The live Docker smoke now uses these strict flags for full decoding and frame extraction, with its existing deadlines.

The cleanup check first evaluates the old cleanup function, retained verbatim from `2f85e90` in `old-cleanup.js.txt`, with deterministic throwing stubs. The snapshot keeps this regression rerunnable after cherry-picking without needing an unpublished commit object. Both removals fail, but the old function returns normally. It then runs the actual repaired CLI with an owned temporary `docker` executable ahead of PATH. That executable implements only simulated build/run/inspect/delete/list operations and never contacts Docker. Permanent removal and verification failure now yields a nonzero CLI exit. Already-absent resources pass only after a successful empty listing. A transient failure is retried. A combined smoke and cleanup failure retains both original errors.

The repaired runner attempts both resource deletions even when one fails, makes at most two attempts per resource, and independently verifies absence using exact owned container-name and image-reference filters. Each removal has a 20-second bound and verification a 10-second bound. `cleanup.json` retains identifiers, attempts, errors and the final result. The final success message is emitted only after cleanup is verified. Signal handlers use the same cleanup guard and expose failures, though signal races were not live-tested here.

The first regression run's combined-error assertion expected the AggregateError wrapper message. Bun rendered its two child errors instead, preserving both. That failed checker output is retained under `first-checker-run/`; the corrected check asserts the two actual error messages. The passing rerun is retained under `passed/`. This change does not hide a runner failure or change the cleanup semantics.

Live VNC probes also validate that the exact verification filters see their owned resources while present, and that both listings are empty after cleanup. Stubbed cleanup results are not a claim that a real Docker daemon outage or forced process death was exercised. No unrelated Docker resources are used or removed by the regression CLI.
