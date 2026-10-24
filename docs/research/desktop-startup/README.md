# Desktop startup repair evidence

This repair belongs to [#141](https://github.com/mangit955/nap/issues/141), which remains open pending production publication and real Chrome validation. It changes only browser startup and its local checks.

## Browser ownership and recovery

`start-desktop.sh` records the launched browser's PID, Linux start ticks, and dev-server port in `/home/user/.nap-desktop/chrome-owner`. Reuse requires the recorded process identity, its exact profile and debugging-port arguments, an owned listening socket, and a healthy debugging endpoint. A repeated same-port start leaves the running browser and its UI state intact.

A port change sends SIGTERM only to that recorded browser after checking its identity again. Startup waits for that process to stop and the debugging port to clear before writing policy and launching the replacement. It retains the profile directory. A browser that refuses to stop causes failure; startup does not escalate to a broad process kill.

Unknown listeners, live processes with mismatched start ticks or profile arguments, and malformed ownership records fail closed. A dead recorded process can be replaced when no listener remains. Startup records ownership before waiting for browser readiness, so a later VNC failure can retry with the same healthy browser. It checks browser health again after VNC readiness.

## Startup preconditions

- Linux must expose readable `/proc/<pid>/stat`, `/proc/<pid>/cmdline`, `/proc/<pid>/fd`, `/proc/net/tcp`, and `/proc/net/tcp6` for the startup user and its browser.
- The Chrome launcher must exec the browser under the launched PID. A launcher that detaches into another PID fails ownership checks.
- Port 9222 must be free or belong to the recorded browser. An already-running browser from the old startup script has no ownership record and is deliberately rejected. A fresh sandbox avoids that migration case.
- The existing Bash, `flock`, `awk`, `grep` with NUL-delimited matching, `readlink`, `curl`, desktop binaries, and writable state and managed-policy paths remain required. No package dependencies were added.
- A malformed record or live identity mismatch requires operator inspection or a fresh sandbox. Startup never adopts an unknown process. An interruption between launching Chrome and recording its identity can also require that recovery.

All desktop processes and profiles remain outside project Git. VNC remains view-only. Xvfb, openbox, and VNC reuse behavior is unchanged.

## Executed checks

On 2026-10-24, `bun run test` passed 5,273 tests across 407 files with no type errors. `bun run typecheck` and `bun run lint` passed. Lint reported one existing CSS specificity warning and one existing template-literal informational finding outside this change. `vitest list --project unit` collected all 18 new tests, and `tsc --listFilesOnly -p packages/sandbox/tsconfig.json` included the suite.

The original port-change regression failed with one browser launch where two were required. A second regression failed because startup returned ready after the browser became unhealthy during VNC startup. Both passed after their repairs.

`packages/sandbox/src/desktop-start.test.ts` executes a fixture copy of the complete shell script. Only fixed state, policy, and `/proc` roots are redirected. Bash command fixtures supply desktop and Linux services without writing host user files. The tests cover reuse, replacement, policy, unknown listeners, process identity, readiness failures, retries, lock failure, and invalid ports.

The guard mutation runner temporarily removes one behavior at a time, requires an assertion failure, and restores the original shell in `finally`. All ten mutations produced assertion failures; [the recorded results](guard-mutations.tsv) include port-change and same-port behavior, start ticks, profile, socket ownership, lock acquisition, health, final readiness, exact localhost policy, and port validation.

```bash
bash docs/research/desktop-startup/guard-mutations.sh
bunx vitest run --project unit packages/sandbox/src/desktop-start.test.ts
```

The free Linux smoke uses the existing `nap-desktop-local-smoke` image and a read-only repository mount:

```bash
docker run --rm --network none --entrypoint bash \
  -e NAP_DESKTOP_START_SMOKE=1 -v "$PWD:/repo:ro" \
  nap-desktop-local-smoke /repo/docs/research/desktop-startup/smoke.sh
```

It passed with two browser stand-in launches; [the recorded report](linux-smoke.json) marks `actualChrome: false`. Real Linux `/proc`, listening sockets, SIGTERM, `flock`, and Xvfb exercised the unchanged production shell. Same-port starts preserved in-memory stand-in UI state; changed-port startup waited for the old listener to close. Concurrent starts serialized, background processes released the startup lock, and an unrelated process survived. Unknown ownership and mismatched ticks were rejected without taking over the listener. A VNC readiness failure retried without replacing the browser.

The image has no Chrome, openbox, x11vnc, websockify, or curl. The smoke uses a Node HTTP browser stand-in, a Node HTTP client in place of curl, and a simulated VNC endpoint. It simulates openbox and x11vnc reuse. The stand-in reads the policy file at process startup. This proves lifecycle ordering and Linux process ownership, but cannot establish Chrome policy loading, navigation blocking, real browser UI restoration, or real VNC behavior.

## Gate coverage and remaining work

The new TypeScript suite matches the unit project glob and the sandbox tsconfig's `src` inclusion. Biome checks the suite. Shell files are outside TypeScript and Biome; `bash -n`, shell-execution tests, guard mutations, and the Linux smoke exercise them. No test globs, dependencies, hooks, or CI files changed. The pre-commit hook must run Biome, typecheck, and changed unit and web tests on the local commit. CI runs the full deterministic suite. The repository's frozen v1 plan and progress files need no changes for this V2 partial issue.

The parent owns regenerating and reviewing the prepared asset manifest after this commit, then approved production publication and real Chrome/E2B validation. Validate Chrome's launcher PID behavior, exact localhost and 127.0.0.1 policy loading, old-port rejection, same-port UI state, and changed-port replacement there. No paid template build, cloud call, model call, push, or PR was made for this repair.
