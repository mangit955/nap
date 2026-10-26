# Frame-update and wait repairs

The [second independent review](review-round2.md) closed the earlier decoder and cleanup findings. It found a false pass in the final VNC image comparison and misplaced Playwright timeout arguments. These repairs affect the local evidence checker only. Production driver and startup bytes remain unchanged.

The old checker compared a later client's frame against an earlier client's image from another origin. The retained pre-input frame already differed from that image, so it passed the exact committed assertion without containing the physical marker. `old-checker/` retains that counterexample and the installed Playwright library's actual 30,000-ms deadlines for calls intended to use 12,000 or 15,000 ms.

The repaired checker captures a baseline from the same adversarial client immediately before the marker input. It counts green pixels in the fixture's result-text rectangle at x=24, y=292, width=500, height=36. After production physical input and a successful production DOM observation, it requires growth of more than 100 result pixels within five seconds. The fixed region excludes browser chrome, input focus and the blue scroll panel. This check is specific to the pinned fixture, font and desktop geometry; it is not a general text recognizer or a stream-latency measurement.

`check-vnc-assertions.mjs` executes the exact checker observation function against retained decoded pixels. The physical marker passes; an unchanged frame, 5,000 changed pixels outside the result region, and a 20-pixel cursor-sized change do not. It also calls the installed Playwright implementation through the checker helper and captures its actual outgoing deadlines. Those are now 12,000, 15,000 and 15,000 ms. `assertions-red/` records the missing observations/helper before repair, and `assertions-green/` records the repaired results.

Run these checks without a browser, Docker or network:

```bash
node docs/research/computer-chrome-linux/check-vnc-assertions.mjs /tmp/nap-vnc-assertions
```

The native negative control exercises the actual frame-update assertion while reusing the same client's pre-input observation. It leaves Chrome and production physical input operational. It must report physical input success, equal before/after result counts, a frame-condition timeout, and a nonzero exit:

```bash
NAP_CHROME_SOURCE_ROOT="$PWD" \
NAP_CHROME_EXPECTED_DRIVER_SHA256=a37b17e66de0576068bdcc44eed9b3a0b47a5f42ed7239287c9e7e3a89cd7a11 \
node docs/research/computer-chrome-linux/check-vnc.mjs /tmp/nap-vnc-frozen frozen
```

This injects a frozen decoded observation. It does not claim to simulate a server or transport stall. Use an empty output directory and follow the prerequisites in the [VNC probe instructions](../vnc/README.md). Omit `frozen` for the normal run. Both runs retain exact production asset hashes and independently verify owned Docker cleanup, listener closure and temporary-profile removal.

## Native results

| Run | Result | Result-region pixels | Total time including cleanup |
| --- | --- | --- | --- |
| `positive/` | Passed | 443 → 997 | 104.737 s |
| `frozen/` | Expected failure | 443 → 443 | 137.826 s |
| `restored/` | Passed | 443 → 997 | 99.573 s |

The frozen run confirms `productionPhysicalInputWorks: true` before its bounded frame-condition failure. All three runs authenticated the installed noVNC client, rejected wrong credentials and adversarial input, and verified cleanup. Independent Docker queries and loopback connection attempts are retained as `parent-cleanup-check.json`. The restored run's checker hash matches the final source. Its final PNG visibly shows `Applied: PHYSICAL-AFTER-VNC`.

Every provenance report matches the separately prepared driver SHA-256 `a37b17e66de0576068bdcc44eed9b3a0b47a5f42ed7239287c9e7e3a89cd7a11` and startup SHA-256 `85fb4d8c8d9d8cfdf0f2cdf248dd19c79bd5666b9228b5d1e0f5f0d0e6a2e342`. The reports honestly record the uncommitted research edits present during the run. No production asset changed. The native core smoke also passed Chrome policy, input and strict recording checks on every run; its reports remain alongside the VNC reports.

`mutations/` retains two deliberate failures. Restoring the wrong Playwright argument slot yields 30,000 instead of 12,000 ms. Expanding observation to the whole frame accepts 5,000 irrelevant background pixels and fails the region check. Both changes were reverted, and the cheap checks and normal native probe passed again.

The JavaScript tools use the existing Biome glob and explicit `node --check` plus manual execution. They are not TypeScript or Vitest suites. The native probe is separate from the default suite because it needs local Chrome, ffmpeg and a Linux desktop container. No new automatic suite, package edge or manifest changed.

Cloud template publication, E2B proxy and SDK validation, complete owner/API/UI integration, real-model trials and matching missing Devin reference states remain outside this evidence. No paid call, push or PR is authorized by these checks. Reaching the 1-GiB local cgroup ceiling still establishes no memory headroom.

## Final gates

`bun run test --maxWorkers=1` passed all 5,587 tests across 425 files in 253.59 seconds, with no type errors. `bun run typecheck` and `bun run lint` passed. Lint retains the existing CSS specificity warning and info. Both JavaScript files passed explicit `node --check`, the cheap assertion CLI passed after restoring the mutations, and the final diff passed whitespace checks. No dependency, test project or architecture rule changed.

`gates/` retains byte-preserving gzip copies of the real command outputs. Read them with `gzip -dc <path>`. Native command outputs are retained beside each native report. These checks do not close the cloud or missing-reference acceptance criteria.
