# Candidate B: real desktop beside a simulated execution plane

## Usage, caller's view

Proposed command: `bun apps/api/scripts/computer-local.ts`. Open its printed actual Nap `/p/<id>` workspace and sign in with its disposable owner.
Preserve API 3038, fixture 3039, Next 3037/PID 31917, their project and database. The new run owns a fresh migrated DB, API 3048 and disposable web app 3047; fail on occupied ports.
The fixed Notes fixture runs inside Docker on 5173. Computer shows that same fixture through real Chrome, while Browser reaches it through a separate loopback bridge.
Show persistent copy: "Scripted model · real Docker desktop · simulated files/git/checks · media kept in RAM until exit".
Test the app performs physical input, reads actual DOM, and leaves a real ffmpeg recording; Watch recording plays/seeks/downloads those bytes.

```ts
// Launcher, after real auth/project/session creation in its own DB.
const sandbox = fakeSandbox(); // Existing fixture; ordinary exec/git/check results remain simulated.
const made = await sandbox.create(created.projectId);
if (!made.ok) throw new Error(made.error.message);
const opened = await openLocalDesktop({ sandboxId: made.value.id, imageId });
if (!opened.ok) throw new Error(opened.error.message);
const local = opened.value;
await sessions.setSandboxId(created.sessionId, made.value.id);
const desktop = new E2BSandboxDesktop({ sandbox: local.transport });
// Bind the fake's preview methods for this ID/5173 to local.previewUrl, with real HTTP readiness.
```
```ts
// Same production composition; other existing auth/queue/event dependencies are unchanged.
const nap = composeNap({ ...existingLocalDeps, sandbox, desktop,
  recordings: desktop, objects: new InMemoryObjectStore(),
  computerAccess: { access: new PostgresProjectComputerAccess(db), secret: authSecret },
  provider: localComputerProvider(),
});
// Register owned cleanup immediately after every successful acquisition, before the next await.
```
```ts
// Launcher finally/signal path; stop admission and await worker cleanup before this call.
const stopped = await local.stop();
if (!stopped.ok) reportLocalFailure(stopped.error); // Never print private driver output.
```

## Problem

`computer-preview.ts` already composes real auth/Postgres/queue/events/UI but supplies FakeSandboxDesktop, fakeSandbox and scripted model/storage.
It omits recordings and computerAccess. Production boot already supplies E2BSandboxDesktop for both desktop and recordings, plus PostgresProjectComputerAccess. Reusing those components avoids a second control API, recorder, test state machine or queue fence.

## Shape

```ts
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { LLMProvider } from "@nap/shared/ports/llm-provider";
import type { Result } from "@nap/shared/result";
type DesktopTransport = Pick<SandboxManager, "exec" | "getPreviewUrl">;
type LocalFailure = { code: "prerequisite" | "startup" | "cleanup"; message: string };
type LocalDesktop = {
  transport: DesktopTransport;
  previewUrl: string;
  stop(): Promise<Result<void, LocalFailure>>;
};
/** Own exactly one container and sandbox identity; reject every other identity/port. */
export async function openLocalDesktop(options: {
  sandboxId: string; imageId: string;
}): Promise<Result<LocalDesktop, LocalFailure>> {
  // TODO: create private container, fixture, binary TCP bridges; unwind partial acquisition.
  throw new Error("not implemented");
}
/** Per-turn script; verdict comes from its matched read_dom tool result, never an edit counter. */
export function localComputerProvider(): LLMProvider {
  // TODO: setup, expectation, physical input, read_dom; then record the observed verdict.
  throw new Error("not implemented");
}
```

Exact production seam: in `packages/sandbox/src/e2b-sandbox-desktop.ts`, narrow only its private field and constructor's sandbox type to `Pick<SandboxManager, "exec" | "getPreviewUrl">`.
All existing full managers remain assignable. No protocol, tool, recorder, runtime or shared-port behavior changes. No dummy lifecycle methods or casts. The factory hides container identity, process pipes, URLs and cleanup; callers retain only the two capabilities production desktop actually needs, per boundary-discipline.
Use one fixed fake sandbox ID captured at bootstrap, no second registry. Validate local options and process results at boundaries; trust existing desktop schemas internally.
Desktop transport exec uses argument-vector `docker exec`, user `user`, `sh -lc` as the in-container shell and bounded stdout sufficient for the existing 21.4 MB recording envelope.
Drain stderr privately, preserve nonzero shell exit as ExecResult, map Docker failures to SandboxError; keep cancellation exec concurrent with a running command.
Run container with `--network=none`, no published ports, private HOME/state, production driver/startup, Chrome 156/Node 24, Xvfb at 1024×768 and ffmpeg.
Start the file-backed fixed Notes fixture inside that container on 5173. Never forward a host fixture into Chrome or expose 9222.
Bind host `node:net` listeners to 127.0.0.1 on ephemeral ports for 5173 and 6080. Each socket gets `docker exec -i` Node TCP piping to the container's loopback port.
Pipe opaque bytes bidirectionally, without a TTY, text decoding or HTTP/WS header reconstruction; apply backpressure, propagate EOF/errors and reap each child on socket close.
The transport getPreviewUrl accepts only 6080; the fake preview override accepts only its fixed ID and port 5173 and returns the other bridge. Probe actual HTTP readiness.
Production E2BSandboxDesktop derives `/websockify` from 6080. Keep x11vnc server viewonly; password stays in memory and the authenticated private stream response.
PostgresProjectComputerAccess remains the owner/input authority. Queued work may exist while idle; an actual leased request blocks input, and the shared project lock prevents claim/input overlap.
Do not serialize all desktop exec calls with a new mutex: production action flock and separate cancellation already own that ordering.

## Next isolation, current evidence

Installed Next 16.3 types/docs accept `conf`, but `next.js` NextCustomServer.prepare forwards no conf to start-server.getRequestHandlers; router-server.initialize loads config again from the app directory.
The internal NextServer path accepts customConfig, but that is not the default custom-server path. Parent also observed second-server refusal for the same app directory, detecting PID 31917.
Choose parent's disposable `.scratch/<run>/web` app directory, copied real source/config/assets, symlinked node_modules, absolute tsconfig base and explicit repository turbopack.root.
Its own app directory and `.next/dev` isolate server identity, build output, locks and generated next-env/tsconfig writes. A tiny copied dev config is enough; no custom server framework.
Launch installed Next CLI under Node with API 3048 env and web 3047; bypass Turbo env filtering. Keep existing transpilePackages and web options in the copy. Parent reports 3047 started, first HTTP compilation pending. Do not claim frontend readiness before a successful real page response and original 3037 health check.

## Module map

- `apps/api/scripts/computer-local.ts`: small no-cloud composition, bootstrap, disposable web copy, signal/finally cleanup; use existing Bun-safe startDockerPostgres.
- `apps/api/scripts/computer-local-desktop.ts` plus `.test.ts`: one exported factory, private Docker/process/bridge helpers; API scripts already enter typecheck.
- `apps/api/scripts/computer-local-model.ts` plus `.test.ts`: independent scripted provider; preserve the old demo provider and edit-counter behavior untouched.
- `packages/sandbox/src/e2b-sandbox-desktop.ts` plus its existing tests: the two narrow type annotations only.
- Local Docker context: adapt desktop-chrome-smoke recipe/startup/driver; fixed fixture and a persistent entrypoint instead of its 240s smoke entrypoint. No new dependencies/package.

## Failure cleanup

Use an acquisition stack in the launcher, register cleanup immediately, unwind in reverse on startup error, signals, web exit or container failure; repeated stop shares one promise.
Stop API admission, stop background loops, drain/abort worker with a deadline while retaining DB/container/objects for existing capture finish/discard; then close sockets and kill bridge children.
Bound desktop exec and shutdown. After graceful cleanup deadline, force-remove only the recorded owned container, reap exact child PIDs, then close DB and remove only its fresh Postgres container.
Remove only this run's frontend/build/context directories and owned temporary image tag; never prune Docker or delete a borrowed image, old DB, 3037/38/39 or another run's resources.
Use unique names/labels, capture container ID as soon as created, verify absence with exact IDs; failed verification is a failed cleanup result. Retain nonsecret diagnostics.
SIGKILL cannot run finally: retain an owned-resource manifest for explicit exact-ID cleanup of a confirmed-dead owner; verify run identity/ownership and never reap a live run.
Reuse production recording cancellation, encoder clock validation, lease-loss suppression and object-key/event ordering. RAM media vanishes on exit; do not advertise durability.
Cached layers may accelerate rebuilding the pinned smoke recipe, but its unique image was deleted. Do not assume it exists or invoke the E2B template publisher.

## Tradeoffs accepted and adequacy

- We accept a simulated file/git/check pipeline for the smallest proof of real Nap owner streaming/input, queued exclusion, screenshots and recording playback.
- What remains fake: sandbox lifecycle/TTL, Files contents, arbitrary commands, git SHA/diff/bundle, deterministic build/check results, synthetic model identity/usage and object durability.
- Fixture HTML is real and Chrome reads its real DOM; it is independent of fake write_file. Fake Fix it edits cannot repair that served app. No mirror writes or hidden fixture toggles to manufacture success.
- Label simulated checkpoint/source behavior in the workspace and every scripted completion. The old model's edits>1 verdict must not survive in this candidate.
- This hybrid is honest and adequate for desktop integration acceptance only. It does not complete the requested real file/build/fix journey; actual files/git/build are feasible, so the final launcher should use the full port.

## Alternatives considered

A full local Docker SandboxManager implements lifecycle/files/exec/preview against the same container: one machine owns sources, git, checks, fixture and desktop. E2BSandboxDesktop needs no type change.
It hides more behind the existing full port, so callers are simpler and Fix it can change actual source; it costs implementation of all existing methods, restore/bundle fidelity and lifecycle conformance.
For the final user task I prefer that full port, retaining only the scripted model and explicitly temporary storage. Candidate B is a bounded proof if the parent needs desktop integration first.
Command-string interception inside fakeSandbox and source mirroring lose: they expose driver internals or duplicate source truth while still claiming fake git/checks are real.

## Synthesis decision

Parent owns arena synthesis. Keep the two-method transport only if accepting the stated partial scope; transplant raw TCP bridging, production composition and disposable Next app directory into a full-port winner.

## Open questions and risks

Can the parent accept a partial desktop proof, or must the real source-to-fix journey work before handoff? Can a locally rebuilt image use cached layers, or does preparation need free downloads? Neither is measured here.

## Tests first, next implementation step

Write and observe failing tests for each new export and the narrowed constructor contract before bodies; include wrong ID/port, driver error/oversize, concurrent cancel, binary bridge fidelity/EOF, partial-start and repeated cleanup.
Provider tests require expectation before input, later screenshot, matched read_dom-derived verdict, missing/error observation never passing, and per-turn state; a controlled app failure must flip the verdict.
Manual Docker/UI check must traverse actual authenticated Nap: fresh framebuffer after physical input, 401/404 nonowner, 409 during a real lease/stale grant, real MP4 ffprobe/seek/download and cancel/encoder/lease-loss failures.
Keep Docker/browser checks opt-in, separate from default Vitest; verify test collection, architecture/hooks coverage, full free gates and production build as implementation acceptance, not claimed design results.
Next step: test the two-method constructor seam and factory failure unwinding first; parent must choose partial desktop proof versus full real-workspace delivery before claiming completion.
