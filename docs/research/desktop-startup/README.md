# Desktop startup repair evidence

This repair belongs to [#141](https://github.com/mangit955/nap/issues/141), which remains open pending production publication and real Chrome validation. It changes only browser startup and its local checks.

## Browser ownership and recovery

`start-desktop.sh` records the browser's PID, Linux start ticks, and dev-server port in `/home/user/.nap-desktop/chrome-owner`. Since [ADR-0019](../../adr/0019-the-desktop-debugger-has-no-port.md) the recorded process is the debugger bridge, which runs Chrome as its child. Reuse requires the recorded process identity, its exact profile, `--remote-debugging-pipe`, `--cdp-bridge` and socket-path arguments, an owned Unix socket listening at exactly `/home/user/.nap-desktop/cdp.sock`, and a browser that answers through it. A repeated same-port start leaves the running browser and its UI state intact.

The launch child first waits for `GO` on an anonymous pipe. The parent reads that child's start ticks, writes the ownership record, and atomically renames it before sending `GO`. The child then execs the debugger bridge, preserving its PID and start ticks; the bridge launches Chrome with the debugging pipe. Only the parent holds the pipe writer. Subprocesses used before publication close it, and the child closes the startup lock. Parent death before `GO`, including SIGKILL, gives the child EOF and prevents Chrome from starting. Write or rename failures have the same outcome. After publication and launch, a surviving browser already has the identity needed for the existing reuse or replacement checks.

A port change sends SIGTERM only to that recorded bridge after checking its identity again. The bridge sends SIGTERM to its browser and exits only once the browser has, killing that one unreaped child only after a grace period. Startup waits for the bridge to stop and the debugger socket to clear before writing policy and launching the replacement. It retains the profile directory. A browser that refuses to stop causes failure; startup does not escalate to a broad process kill.

Unknown listeners, live processes with mismatched start ticks or profile arguments, and malformed ownership records fail closed. A dead recorded process can be replaced when no listener remains. Startup records ownership before waiting for browser readiness, so a later VNC failure can retry with the same healthy browser. It checks browser health again after VNC readiness.

## Startup preconditions

- Linux must expose readable `/proc/<pid>/stat`, `/proc/<pid>/cmdline`, `/proc/<pid>/fd`, and `/proc/net/unix` for the startup user and its bridge.
- The Chrome launcher must keep the debugging pipe on descriptors 3 and 4 and exit with the browser. The bridge's own PID is the recorded one, so a launcher that forks is no longer an ownership problem, only a lifetime one.
- The debugger socket path must be free, stale, or held by the recorded bridge. A browser from an older startup script, including one with a debugging port, has a record whose process carries no bridge arguments, and is deliberately rejected. A fresh sandbox avoids that migration case.
- The existing Bash, `flock`, `awk`, `grep` with NUL-delimited matching, `readlink`, `curl` (for VNC only), Node and the driver bundle, desktop binaries, and writable state and managed-policy paths remain required. No package dependencies were added.
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

The guard mutation runner temporarily removes one behavior at a time, requires an assertion failure, and restores the original shell in `finally`. All fourteen mutations produced assertion failures; [the recorded results](guard-mutations.tsv) include the original ten ownership and readiness guards, plus waiting for `GO`, exiting on pipe EOF, publication before release, and preserving the browser PID through exec. The private debugger added eight more; see below.

```bash
bash docs/research/desktop-startup/guard-mutations.sh
bunx --no-install vitest run --project unit packages/sandbox/src/desktop-start.test.ts
```

The free Linux smoke uses the existing `nap-desktop-local-smoke` image, a read-only repository mount, and the freshly bundled driver mounted where the image installs it, so the real bridge runs:

```bash
bun build packages/sandbox/scripts/desktop-driver.ts --target=node --format=esm \
  --outfile=/tmp/nap-desktop-driver.mjs
docker run --rm --network none --entrypoint bash \
  -e NAP_DESKTOP_START_SMOKE=1 -v "$PWD:/repo:ro" \
  -v /tmp/nap-desktop-driver.mjs:/usr/local/lib/nap-desktop/driver.mjs:ro \
  nap-desktop-local-smoke /repo/docs/research/desktop-startup/smoke.sh
```

It first passed with eight browser stand-in launches; [the current report](linux-smoke.json), from the private-debugger run below, marks `actualChrome: false`. Real Linux `/proc`, listening sockets, SIGKILL, SIGTERM, pipes, `flock`, and Xvfb exercised the production shell. The four publication faults each proved the waiting child exited without launching a browser and that retry recovered. A separate parent death after launch recovered through the durable ownership record. Same-port starts preserved in-memory stand-in UI state; changed-port startup waited for the old listener to close. Concurrent starts serialized, background processes released the startup lock, and an unrelated process survived. Unknown ownership and mismatched ticks were rejected without taking over the listener. A VNC readiness failure retried without replacing the browser.

To reproduce the Linux RED check, export the original script with `git show b1b3866:packages/sandbox/desktop/start-desktop.sh > /tmp/nap-desktop-before-barrier.sh`. Add `-e NAP_DESKTOP_START_SCRIPT=/tmp/start-before-repair.sh -v /tmp/nap-desktop-before-barrier.sh:/tmp/start-before-repair.sh:ro` to the Docker command. The smoke accepts this override only for its test input; production startup has no fault-injection flags. Run that check with the smoke as of `0c19f1a`, whose stand-in browser listened on 9222; the current stand-in speaks only the pipe.

The image has no Chrome, openbox, x11vnc, websockify, or curl. The smoke uses a browser stand-in that speaks Chrome's pipe contract behind the real bridge, a Node HTTP client in place of curl, and a simulated VNC endpoint. It simulates openbox and x11vnc reuse. The stand-in reads the policy file at process startup. This proves lifecycle ordering and Linux process ownership, but cannot establish Chrome policy loading, navigation blocking, real browser UI restoration, or real VNC behavior.

## Gate coverage and remaining work

The new TypeScript suite matches the unit project glob and the sandbox tsconfig's `src` inclusion. Biome checks the suite. Shell files are outside TypeScript and Biome; `bash -n`, shell-execution tests, guard mutations, and the Linux smoke exercise them. No test globs, dependencies, hooks, or CI files changed. The pre-commit hook must run Biome, typecheck, and changed unit and web tests on the local commit. CI runs the full deterministic suite. The repository's frozen v1 plan and progress files need no changes for this V2 partial issue.

The parent owns regenerating and reviewing the prepared asset manifest after this commit, then approved production publication and real Chrome/E2B validation. Validate Chrome's launcher PID behavior, exact localhost and 127.0.0.1 policy loading, old-port rejection, same-port UI state, and changed-port replacement there. No paid template build, cloud call, model call, push, or PR was made for this repair.

## Private debugger

[ADR-0019](../../adr/0019-the-desktop-debugger-has-no-port.md) removed the debugging port after real E2B desktops refused to start beside a second listener on 9222 whose holder was not visible to the desktop user. That listener is consistent with envd forwarding, but its process identity and precise forwarding mechanism remain inferred; public DevTools exposure was not measured. The private Unix socket removes TCP debugging without relying on that mechanism. The ownership, launch-barrier, reuse and replacement properties above are unchanged; the identity they check is now the bridge's, and the listener they check is the Unix socket.

[The reproduction](forwarder-red.txt) gives the previous script and fixture a listener that appears beside the browser's, as on E2B. It fails with the diagnostic's exact line, "Port 9222 is not owned by this desktop." The current suite starts beside a foreign 9222 listener, refuses a foreign listener at the debugger path, ignores sockets at other paths and sockets that are not listening, and checks that the browser is launched with the pipe and no debugging port or address.

The guard mutation runner now applies twenty-two mutations, each producing an assertion failure ([results](guard-mutations.tsv)). The eight new ones drop the pipe, bridge and socket-path identity checks, count non-listening sockets or sockets at any path, trust an answer from a listener the script cannot place, add a debugging port back to the launch, and launch the browser without the bridge.

The Linux smoke passed with nine stand-in launches through the real bridge ([report](linux-smoke.json)). Beyond the earlier properties it found no TCP listener on 9222, a `0600` socket, a stand-in browser that exited when its bridge was SIGKILLed, and a stale socket replaced on the next start.

Against real Chrome 156 in the local desktop image, run as `user` with two CPUs and 1 GiB, the freshly bundled driver and this script started the desktop, left nothing listening on 9222, created `srw-------` at the debugger path, read the page's DOM and console through the driver, reused the browser on a same-port start and replaced it on a port change. A SIGKILLed bridge took Chrome with it within 0.3 seconds, and the next start replaced its stale socket. The repository's full Chrome smoke, run against that image with the fresh bundles mounted, passed every step, including physical input, policy-blocked pages and recording. No E2B sandbox, template publication or model call was used.
