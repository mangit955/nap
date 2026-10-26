# Local app design cross-judge B

## Verdict

Pick candidate A as the base. The numeric totals tie, but criterion 1 is a release gate, not a compensating score. B deliberately keeps files, Git, commands, and checks simulated, and its served fixture cannot be repaired by Fix it. It therefore cannot complete the original task.

This is a design judgment only. The supplied grounding says no full local Docker manager exists and no end-to-end acceptance was run.

| Criterion | A | B | Judgment |
|---|---:|---:|---|
| 1. One real source for Nap UI, Docker app, files, Git, checks, and Fix it | 2 | 0 | A routes the full `SandboxManager` and Vite through `/home/user/app`. B explicitly uses `fakeSandbox()` plus an independent fixed fixture. |
| 2. Reuse production desktop, owner guard, and recorder | 2 | 2 | Both reuse `E2BSandboxDesktop`, `PostgresProjectComputerAccess`, and the production recording path. Neither proposes a second control authority or recorder. |
| 3. Preserve 3037/3038/3039 and DB; disposable web; no cloud/model calls | 1 | 1 | Both isolate ports, DB, web output, model, and RAM media. Both prescribe an absolute `tsconfig` base/extends, now disproved by the parent's prototype, so their proposed web copy does not yet meet the runnable requirement. |
| 4. Narrow deep interface; avoid unnecessary production changes | 1 | 1 | A chooses the correct existing full port, but exports a local-only manager from `packages/sandbox` and proposes a conformance change before proving either is needed. B's two-method production type change exists only to support its inadequate split plane. |
| 5. Bounded owned startup/cancel/shutdown; concurrent cancel; binary transport | 1 | 2 | A has exact IDs, bounds, idempotence, and raw bridges, but does not explicitly preserve the driver's second concurrent cancellation exec or drain the worker before closing the manager. B specifies both, plus reverse unwind and a shared stop promise. |
| 6. Rerunnable UI/media/auth/lease negative acceptance | 1 | 2 | A covers the main UI, real lease 409, MP4, range, download, and fail/pass path, but omits explicit non-owner, stale-grant, cancellation, encoder, and lease-loss negatives. B lists those checks and exact cleanup for reruns. |
| **Total** | **8/12** | **8/12** | A wins because B scores zero on the task's defining outcome. |

## Minimal grafts into A

1. Keep the full `SandboxManager` approach, but place `LocalDockerSandboxManager` and its helpers under `apps/api/scripts`. Do not export a new production provider or alter `E2BSandboxDesktop` unless a failing contract test proves that necessary. Compose through the real `composeNap` entry point, not the unexplained `composeApp` name in A.
2. Use B's acquisition stack. Register each resource immediately; stop admission; boundedly drain or abort the worker while DB, object bytes, and desktop still exist; then close bridges, container, web, API, and owned Postgres. Make concurrent callers share one stop promise and verify exact-ID absence.
3. Make every `exec` independent so the driver cancellation request can run while the action exec is blocked. Preserve nonzero exits as command results, drain stderr privately, allow the recording response envelope, and test raw binary bridge backpressure, half-close, EOF, and child reaping.
4. Copy the web app to a run-owned directory and launch normal Next CLI there. The copied `tsconfig` must extend the repository root by a relative path. Do not use an absolute `extends`; the parent observed Turbopack 500 with it and HTTP 200 only with the relative form.
5. Start local development at 2 GiB or make the limit explicit and configurable. The observed 1 GiB smoke reached its ceiling, so 1 GiB is not an established safe value and says nothing about production sizing.
6. The current smoke image has Node 24 and Chrome, not Bun. If the real template starts Vite with Bun, install the repository's pinned `packageManager` version in the image.
7. Add B's negative acceptance cases to A: non-owner 401/404 without leaked identity, stale grant rejection, input 409 under a real active lease, cancellation during a blocked action, encoder failure, lease loss, range seek, byte-identical download, double cleanup, and a second clean run.

## Unsupported or contradicted claims

- A's statement that the smoke recipe supplies pinned Bun is contradicted by the parent's current smoke inventory.
- A's 1 GiB limit is a proposal, not evidence of adequate headroom; the only reported measurement hit that limit.
- Both candidates' absolute `tsconfig` prescription is contradicted by the completed prototype.
- A's real file/Git/check/snapshot behavior, manual Fix it flow, cache reuse, and full cleanup are intended behavior, not established results. The grounding found no complete Docker `SandboxManager` and ran no acceptance.
- B cannot claim task completion or a source-driven fail/fix/pass result. It admits that fake writes cannot repair its served fixture.
- B's 3047/frontend readiness statement was pending compilation in its own report. Only the parent's later relative-extends HTTP 200 establishes a viable copied-app direction.
- Neither design proves that 3037/3038/3039 and the existing DB remain healthy after the replacement starts and stops. Make those before/after health checks part of acceptance without mutating the old run.
