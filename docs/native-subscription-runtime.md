# Native subscription execution

The production boot still exposes no subscription sign-in or native model catalog. The offline
implementation does not establish a provider approval, a working hosted login, or a successful
subscription-backed model request. Track release work in [#165](https://github.com/mangit955/nap/issues/165).

An API turn continues through `NapAgentService`. A subscription turn carries its account,
model and authorization generation through admission, the queue, continuation and repair. It
enters `NativeAgentService` without API credentials or Messages API history. The composed
application supplies its native executor and model catalog together. Without them, selection
is unavailable and execution never falls back to an API model.

The experimental Claude helper uses the Agent SDK. It accepts one bounded private start
command, checks first-party subscription authentication before offering a prompt, and lets
Claude own its conversation. Local tools, plugins, hooks and project settings are disabled.
The six Nap tools use an SDK-owned MCP server and a run-bound workspace client. Unknown
receipts and uncertain tool outcomes stop execution. This helper belongs in an isolated
authenticated runtime; it must never be installed alongside arbitrary project code with access
to that code's credential home.

The SDK environment excludes API keys and cloud authentication. `client_composed` input avoids
local file mention and slash-command expansion. The output adapter publishes recognized text
and thinking, suppresses full-message duplicates of streamed content, and keeps raw diagnostics,
stderr and private control frames out of public chat events. Private raw delivery remains
subject to the encrypted native journal and its durable cursor.

`NativeAgentService` calls finalization only after the executor returns cgroup termination
receipts for the agent and every project writer. SDK close or a process-group receipt is
insufficient. Unconfirmed termination prevents verification, repair and repository publishing.
The durable native run fence must remain until authenticated physical termination is proved.
The outer runtime still owns jobs, bounded repair, verification, commits and snapshots.

## Free checks

Run the regular test, typecheck and lint commands. The composition test exercises subscription
admission through a worker using a fixture executor and asserts that no API key is read and no
API model starts. SDK session tests inject a query fixture; MCP tests use the actual MCP protocol.
These prove Nap's behavior, not provider entitlement or a remote process boundary.

`bun run --cwd packages/agent native-helper:smoke` builds the Node helper and drives its actual
entry point with invalid private commands. It makes no authentication or model request. The
helper and smoke source both live under `src`, so normal TypeScript and lint gates include them.

## Remaining release work

The helper is not yet connected to a production runtime allocator, a supervised workspace tool
gateway or interactive CLI login. Account-private native archives, coherent recovery checkpoints,
worker-loss reconciliation, preview write containment and provider-specific acceptance remain
open. Browser automation did not validate the picker visually because the available preview
repeatedly timed out; component tests cover its behavior.

The Claude SDK route requires the applicable third-party subscription approval. Conditional
stock CLI hosting is a different route and must not be treated as SDK approval. Hosted Codex
requires the supported OpenAI partner route; desktop CLI/device-code success is not a substitute.
Keep these gates separate from implementation tests and from the two completed E2B transport
probes. No subscription authentication or model call has run as part of these checks.
