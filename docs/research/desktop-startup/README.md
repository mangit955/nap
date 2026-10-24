# Desktop startup repair evidence

This repair belongs to [#141](https://github.com/mangit955/nap/issues/141), which remains open pending production publication and real Chrome validation. It changes only browser startup and its local checks.

## Browser ownership and recovery

`start-desktop.sh` records the browser's PID, Linux start ticks, and dev-server port in `/home/user/.nap-desktop/chrome-owner`. Reuse requires the recorded process identity, its exact profile and debugging-port arguments, an owned listening socket, and a healthy debugging endpoint. A repeated same-port start leaves the running browser and its UI state intact.

The launch child first waits for `GO` on an anonymous pipe. The parent reads that child's start ticks, writes the ownership record, and atomically renames it before sending `GO`. The child then execs the Chrome launcher, preserving its PID and start ticks. Only the parent holds the pipe writer. Subprocesses used before publication close it, and the child closes the startup lock. Parent death before `GO`, including SIGKILL, gives the child EOF and prevents Chrome from starting. Write or rename failures have the same outcome. After publication and launch, a surviving browser already has the identity needed for the existing reuse or replacement checks.

A port change sends SIGTERM only to that recorded browser after checking its identity again. Startup waits for that process to stop and the debugging port to clear before writing policy and launching the replacement. It retains the profile directory. A browser that refuses to stop causes failure; startup does not escalate to a broad process kill.

Unknown listeners, live processes with mismatched start ticks or profile arguments, and malformed ownership records fail closed. A dead recorded process can be replaced when no listener remains. Startup records ownership before waiting for browser readiness, so a later VNC failure can retry with the same healthy browser. It checks browser health again after VNC readiness.

## Startup preconditions

- Linux must expose readable `/proc/<pid>/stat`, `/proc/<pid>/cmdline`, `/proc/<pid>/fd`, `/proc/net/tcp`, and `/proc/net/tcp6` for the startup user and its browser.
- The Chrome launcher must exec the browser under the launched PID. A launcher that detaches into another PID fails ownership checks.
- Port 9222 must be free or belong to the recorded browser. An already-running browser from the old startup script has no ownership record and is deliberately rejected. A fresh sandbox avoids that migration case.
- The existing Bash, `flock`, `awk`, `grep` with NUL-delimited matching, `readlink`, `curl`, desktop binaries, and writable state and managed-policy paths remain required. No package dependencies were added.
- A malformed record or live identity mismatch requires operator inspection or a fresh sandbox. Startup never adopts an unknown process.

The pipe protocol covers startup-process interruption, not a kernel crash or storage loss. Publication uses the existing atomic rename and does not add fsync or a journal. If the parent dies after publication but before `GO`, the waiting child exits; its dead record can be replaced once that exit is visible. An immediate retry can briefly fail closed while that child exits.

All desktop processes and profiles remain outside project Git. VNC remains view-only. Xvfb, openbox, and VNC reuse behavior is unchanged.

## Executed checks

On 2026-10-24, the baseline after cherry-picking `b1b3866106ccafbfbb6044fbb813fe54bbfb75a8` passed 5,360 tests across 410 files with no type errors. The interruption repair adds five tests, for 23 focused startup tests. `vitest list --project unit` collects them, and `tsc --listFilesOnly -p packages/sandbox/tsconfig.json` includes the suite.

After the repair, `bun run test` passed 5,365 tests across 410 files with no type errors. `bun run typecheck`, `bun run lint`, individual `bash -n` checks on all three shell files, and `git diff --check` passed. Lint retained one existing CSS specificity warning and one existing template-literal informational finding outside this change. [The gate output](gate-results.txt) records the full-suite result, typecheck, lint, and collection checks. Dependencies were installed from the local cache with `bun install --frozen-lockfile --offline`; no lockfile changed.

The original port-change regression failed with one browser launch where two were required. A second regression failed because startup returned ready after the browser became unhealthy during VNC startup. Both passed after their repairs.

The accepted P2 review found a gap between browser launch and ownership publication. Before this repair, the new command-level fault injections observed a launched browser after SIGKILL before rename, SIGKILL after rename, rename failure, and record-write failure. [The RED unit output](interruption-red.txt) records four assertion failures. The expanded free Linux smoke also failed against the original script: [its RED output](linux-interruption-red.txt) records a surviving child and its live debugging endpoint after the startup parent was killed before rename. This is an executed reproduction, not just a source-based timing argument.

After the pipe repair, both suites pass. Before publication, interruption or write failure leaves no browser listener and a retry succeeds. Interruption after rename but before `GO` leaves a replaceable dead record. SIGKILL after `GO` leaves an owned browser that same-port retry reuses and changed-port retry replaces. Existing unknown-listener and identity-mismatch checks remain fail closed.

`packages/sandbox/src/desktop-start.test.ts` executes a fixture copy of the complete shell script. Only fixed state, policy, and `/proc` roots are redirected. Bash command fixtures supply desktop and Linux services without writing host user files. The tests cover reuse, replacement, policy, unknown listeners, process identity, readiness failures, retries, lock failure, and invalid ports.

The guard mutation runner temporarily removes one behavior at a time, requires an assertion failure, and restores the original shell in `finally`. All fourteen mutations produced assertion failures; [the recorded results](guard-mutations.tsv) include the original ten ownership and readiness guards, plus waiting for `GO`, exiting on pipe EOF, publication before release, and preserving the browser PID through exec.

```bash
bash docs/research/desktop-startup/guard-mutations.sh
bunx --no-install vitest run --project unit packages/sandbox/src/desktop-start.test.ts
```

The free Linux smoke uses the existing `nap-desktop-local-smoke` image and a read-only repository mount:

```bash
docker run --rm --network none --entrypoint bash \
  -e NAP_DESKTOP_START_SMOKE=1 -v "$PWD:/repo:ro" \
  nap-desktop-local-smoke /repo/docs/research/desktop-startup/smoke.sh
```

It passed with eight browser stand-in launches; [the recorded report](linux-smoke.json) marks `actualChrome: false`. Real Linux `/proc`, listening sockets, SIGKILL, SIGTERM, pipes, `flock`, and Xvfb exercised the production shell. The four publication faults each proved the waiting child exited without launching a browser and that retry recovered. A separate parent death after launch recovered through the durable ownership record. Same-port starts preserved in-memory stand-in UI state; changed-port startup waited for the old listener to close. Concurrent starts serialized, background processes released the startup lock, and an unrelated process survived. Unknown ownership and mismatched ticks were rejected without taking over the listener. A VNC readiness failure retried without replacing the browser.

To reproduce the Linux RED check, export the original script with `git show b1b3866:packages/sandbox/desktop/start-desktop.sh > /tmp/nap-desktop-before-barrier.sh`. Add `-e NAP_DESKTOP_START_SCRIPT=/tmp/start-before-repair.sh -v /tmp/nap-desktop-before-barrier.sh:/tmp/start-before-repair.sh:ro` to the Docker command. The smoke accepts this override only for its test input; production startup has no fault-injection flags.

The image has no Chrome, openbox, x11vnc, websockify, or curl. The smoke uses a Node HTTP browser stand-in, a Node HTTP client in place of curl, and a simulated VNC endpoint. It simulates openbox and x11vnc reuse. The stand-in reads the policy file at process startup. This proves lifecycle ordering and Linux process ownership, but cannot establish Chrome policy loading, navigation blocking, real browser UI restoration, or real VNC behavior.

## Gate coverage and remaining work

The new TypeScript suite matches the unit project glob and the sandbox tsconfig's `src` inclusion. Biome checks the suite. Shell files are outside TypeScript and Biome; `bash -n`, shell-execution tests, guard mutations, and the Linux smoke exercise them. No test globs, dependencies, hooks, or CI files changed. The pre-commit hook must run Biome, typecheck, and changed unit and web tests on the local commit. CI runs the full deterministic suite. The repository's frozen v1 plan and progress files need no changes for this V2 partial issue.

The parent owns regenerating and reviewing the prepared asset manifest after this commit, then approved production publication and real Chrome/E2B validation. Validate Chrome's launcher PID behavior, exact localhost and 127.0.0.1 policy loading, old-port rejection, same-port UI state, and changed-port replacement there. No paid template build, cloud call, model call, push, or PR was made for this repair.
