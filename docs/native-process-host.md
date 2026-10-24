# Native process supervision

The subscription executor needs an interactive process in the project's sandbox. The current
API agent still uses `SandboxManager.exec`. `SandboxProcessHost` adds a separate seam for
bidirectional native-agent processes, private reconnect references, host-side lease expiry,
bounded output, and acknowledged delivery. Production boot does not enable a subscription
provider through this module yet.

## Run the offline proof

Run these commands from the repository root:

```sh
bun run --cwd packages/sandbox native-host:smoke
bun run --cwd packages/sandbox native-host:probe
bunx vitest run --project unit packages/shared/src/native-process-protocol.test.ts packages/sandbox/src/native-process-host.test.ts packages/sandbox/src/e2b-process-host.test.ts
```

The smoke command builds the self-contained Node supervisor and drives its stdin and stdout
through a real local subprocess. It requires no credentials, model, or E2B allocation. Local
tests deliberately use process-group containment and demonstrate that a detached descendant
can survive it. That mode cannot authorize native finalization in production.

The probe command defaults to a dry-run. Adding `--real` requires explicit approval for one
paid E2B sandbox and a privately configured `E2B_API_KEY`. It caps the sandbox lifetime at
60 seconds, tests privilege restrictions and detached-child termination, and destroys the
sandbox in a `finally` block. It does not sign in to a provider or make a model call.

## Delivery and lifecycle

The supervisor receives one validated start frame, then authenticates every control frame
with its private random token. Child processes inherit only the supplied environment. Command
arguments pass directly to `spawn`, without shell interpolation. Protocol failures return
fixed messages and never echo the offending frame.

Each output frame carries a sequence number. The supervisor keeps bounded, unacknowledged
output for replay and terminates on output or replay overflow. `E2BProcessHost` awaits the
caller's persistence callback before acknowledging a frame. Replay deduplicates acknowledged
identities; a gap fails explicitly. The callback must persist delivery identity together with
its effects. A terminal receipt is required even if the outer E2B command exits successfully.

The host owns the lease timer. Losing the worker therefore cannot extend native execution.
Disconnecting the SDK stream leaves the process running only until renewal expires. Startup,
reconnection, and control writes have deadlines. An uncertain startup is never permission to
start another copy. Reconnect references contain authentication material and must stay out of
URLs, logs, event payloads, project snapshots, and browser responses.

## Linux containment

The E2B adapter always requests a root-owned cgroup v2 subtree. Before user code runs, a
bootstrap process joins that subtree and invokes `setpriv` to drop the user, groups, and all
capabilities and set `no-new-privs`. This prevents a passwordless `sudo` configuration from
allowing user code to move itself out of the containment group. Termination uses `cgroup.kill`,
and only an empty group can produce a cgroup termination receipt. An unavailable controller,
bootstrap, or privilege-drop executable must not cause a process-group fallback.

The supervisor must be staged as a root-owned file outside `/home/user/app`, with a trusted
Node runtime and `/usr/bin/setpriv`. The build command emits
`packages/sandbox/dist/native-process-host.mjs`. The artifact path is supplied to
`E2BProcessHost`; building it does not publish an E2B template or install it in production.

Writable cgroup delegation, unprivileged escape prevention, detached-child termination, E2B
reconnect behavior, and the staged artifact's ownership need an authorized live E2B proof.
Local process tests and an injected SDK client do not establish those properties on E2B.
PTY login input, provider-specific authentication, credential isolation from native tools,
and durable native-session archives are later integrations. No claim of live subscription
authentication follows from a passing transport test.
