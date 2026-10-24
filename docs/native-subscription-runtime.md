# Native subscription execution

The production boot still exposes no subscription sign-in or native model catalog. On 2026-10-24,
the owner reported neither provider approval as confirmed. Both approval gates remain closed. The offline
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

`bun run --cwd packages/agent native-helper:proof` runs the built helper with the actual pinned
Agent SDK and a local scripted CLI in a temporary, empty credential home. It checks private
composed input, SDK tool provenance, user-forced permission asks, MCP request/receipt handling,
streamed Unicode and duplicate suppression. It verifies the initialization wire disables MCP
automatic backgrounding, including a setting supported by SDK 0.3.310's runtime but omitted from
its public server type. This exercises no real provider CLI, authentication or model endpoint.
It does not prove E2B containment or subscription entitlement.

The code-entry UI and its separate POST endpoint carry only a single-use code and attempt ID.
The account stays unverified after input receipt. The actual native login driver is still absent;
the browser driver refuses terminal input, and production exposes no terminal code prompt.

## Remaining release work

The helper now connects through `ClaudeNativeExecutor` to the supervised process port and
`NativeWorkspaceGateway`. The gateway journals tool intent before effects, refuses duplicate
call IDs, and runs commands through cgroup-supervised processes rather than aggregate exec.
A scripted test exercises native MCP editing, git finalization, a failed check and a native repair.
It uses fixture process receipts and cannot establish physical isolation on its own.

Production still needs the isolated runtime allocator and interactive CLI login. The project
profile must prove that project code cannot reach a privileged control channel or leave writers
outside containment. Preview servers need a separate, proven write boundary. Account-private
native archives, coherent recovery checkpoints,
worker-loss reconciliation, preview write containment and provider-specific acceptance remain
open. Browser automation did not validate the picker visually because the available preview
repeatedly timed out; component tests cover its behavior.

The Claude SDK route requires the applicable third-party subscription approval. Conditional
stock CLI hosting is a different route and must not be treated as SDK approval. Hosted Codex
requires the supported OpenAI partner route; desktop CLI/device-code success is not a substitute.
Keep these gates separate from implementation tests and from the two completed E2B transport
probes. No subscription authentication or model call has run as part of these checks.

## Provider route decision, 2026-10-24

[Anthropic's SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) requires prior
approval for third-party products offering Claude subscription login or limits. Its
[programmatic CLI guide](https://code.claude.com/docs/en/headless) also describes `claude -p`
as SDK use. Swapping the SDK library for that flag does not establish an approved production
route for Nap's automated chat integration.

There is a separate, conditional exception for hosting an unmodified Claude Code binary with
end users' own authentication under the [hosting conditions](https://code.claude.com/docs/en/legal-and-compliance).
That exception must not be presented as blanket SDK approval, or as a blanket ban on CLI
hosting. A direct hosted CLI terminal is a different product experience from the integrated
Nap chat plan. Confirm the applicable route before further production-driver implementation.

OpenAI's [app-server authentication documentation](https://learn.chatgpt.com/docs/app-server)
excludes commercial and hosted services from built-in authentication. Its
[ChatGPT plan usage documentation](https://developers.openai.com/siwc/token-sharing-open-source)
directs paid or remotely hosted applications to the partner-interest route. No local CLI or
device-code fallback has been installed for hosted Nap.
