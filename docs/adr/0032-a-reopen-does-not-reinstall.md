# ADR-0032: A reopen does not reinstall, and its round trips overlap

**Status:** Accepted, 2026-11-09. Built and tested on fakes and against a real shell, git and tar. The real-E2B round trip (`restore.integration.test.ts`) has been written for it but not run, so no reopen has been timed on a real sandbox.

## Context

Opening a project whose sandbox was reaped (`openProject`, `packages/runtime/src/restore.ts`) had two problems.

**It reinstalled dependencies on every reopen once a project had added any.** The restore read `bun.lock` and `bun.lockb` before unbundling, which gave the template's lockfile, and again afterwards, which gave the project's. It ran a blocking `bun install` whenever the two differed. That check is right for the image's baked `node_modules`. But a project that ever ran `bun add` always differs, so it paid an install (about a minute, according to GOTCHAS; up to `RESTORE_INSTALL_TIMEOUT_MS`) on every reopen, forever.

**It made eleven sandbox round trips, one after another:** `create`, two lockfile reads, the bundle upload, five git commands and two more lockfile reads. Before any of that it read the snapshot row and then the bundle, also in series. The ordering was deliberate: nothing was created until the bytes were in hand, so a storage outage cost nothing.

## Options considered

**(a) Cache `node_modules` in object storage, keyed by what decides it.** The cache is plain bytes in the bucket we already have, behind the `ObjectStore` port we already have. It costs storage plus one download and extract per reopen. It works however long the project has been idle.

**(b) Pause idle sandboxes instead of destroying them.** E2B supports `pause`, `lifecycle.onTimeout: "pause"` and resume-on-connect (`e2b` 2.38 types). A resumed sandbox has everything, running processes included, so a recent reopen would cost about a second and install nothing. We rejected it as the fix, for four reasons:

- **It does not remove the cold path.** A paused sandbox is still eventually deleted. A project reopened after that comes back through restore, and without (a) it reinstalls. So pausing would be a layer over (a), not a replacement for it.
- **It changes the reaper, the inventory and capacity at once.** `SandboxInventory.list` asks only for running sandboxes, deliberately, because "destroying somebody else's paused work … is the one mistake here that cannot be undone" (`e2b-sandbox-manager.ts`). Pausing would make paused sandboxes ours. Then the reconciler has to see them, the capacity ceiling has to decide whether a paused sandbox holds a slot, and the idle sweep (which another change, #223, is reworking now) has to pause rather than tear down. Each of those is the kind of change `docs/scaling-design.md` needs an argument for.
- **The snapshot is still needed.** Work has to survive a sandbox lost by any route. ADR-0022 D2 keeps the per-turn snapshot under the lease, so pausing would add a second copy rather than replace the first.
- **The cost of storing paused sandboxes is unknown** to this repo, and no run here has measured how fast a resume is.

**(c) Both.** Pausing remains a worthwhile follow-up on top of (a), for the reopen within minutes. It is written up below rather than half-built.

## Decisions

### D1: One archive per project, keyed by the install's exact inputs

The restore's probe (D3) reads a sha256 of `git ls-tree HEAD -- package.json bun.lock bun.lockb bunfig.toml .npmrc patches`, together with `bun --revision`, `node --version` and `uname -m`. It reads this once on the template's tree and once on the project's. If the two are equal, the baked `node_modules` is already the project's, which is what keeps most reopens at seconds. Otherwise the cache key is `sha256(template ‖ project)`:

- **`package.json`, not only the lockfile.** The lockfile does not record everything an install acts on, such as the root package's own `postinstall`. A project that edits only its scripts now goes down the cache path where it used to skip. The first such reopen runs an install that finds nothing to do, and stores the result.
- **The template's side and the toolchain.** A restore installs on top of the baked dependencies, using the image's Bun and Node. Without the template's side in the key, a rebuilt template would be handed archives that a different image installed. With it, each archive misses once after a rebuild.
- **Computed in the sandbox, not baked into the image.** The brief suggested precomputing the template's hash. Reading it inside the restore's own command costs no extra round trip, and a hash read in the sandbox cannot disagree with the image it was read from. A constant could, after any rebuild.
- **Unreadable is "cannot tell", never "equal".** A key is exactly 64 lowercase hex characters, or it is not a key. A probe that printed nothing (say, a missing `sha256sum`) leads to an install, never to a skip.

The archive is stored at `projects/<projectId>/dependencies.tar.gz`. The stored object starts with a header line naming its key, then the gzipped tarball. **An archive is extracted only when its header key equals the key just computed.** Anything else is a miss: no object, an object storage cannot return, a header that does not parse, a different key, a failed upload into the sandbox, or a tarball that will not extract. **A miss installs**, exactly as before. Extraction unpacks next to the project and swaps the result in only after it succeeded, so a corrupt archive leaves the existing tree untouched for the install to work from.

**Per project, not shared by content.** A shared, content-addressed store would let two projects with the same inputs share one archive. But it would grow without bound, could not be deleted with a project (the port cannot list), and could carry one project's files to another: a trusted dependency's `postinstall` can read the project it is installed into. One object per project is bounded by the number of projects, is replaced in place when the inputs change, and is deleted by `deleteProject` alongside the thumbnail, from the same derived key.

### D2: Only an install that a restore ran is archived, and only if nothing moved

An archive is written after a cache miss, from the tree the restore's own `bun install` left. That is the tree the old code produced on every reopen, so a later hit restores it exactly. It is not written from the live sandbox at the end of a turn: the agent can install with npm, patch a dependency by hand, or leave `node_modules` disagreeing with the lockfile, and none of that is what an install from the committed inputs produces. The cost is that the first reopen after a change to the dependencies still installs, once.

Packing takes seconds (packing the template's own 134 MB `node_modules`, installed on a developer's Mac rather than in a sandbox, took 4.6 s and produced 33 MB), so it runs **after `openProject` has returned**. Nothing the user waits for waits on it. Because the turn is running while the archive is made, the archive is refused if anything changed:

- **The install itself moved the inputs.** The install reads the key again in the same command. If the install rewrote the lockfile, the committed inputs did not decide its result, so nothing is stored.
- **The tree moved after the install.** The install leaves a record listing the packages present when it finished. After packing, the archive command checks that no entry under `node_modules` is newer than that record and that the package list is unchanged. Edits, additions and removals are all refused. Tool caches (`.vite`, `.vite-temp`, `.cache`, `.tmp`) are left out of the archive, ignored by the check, and carried across an extraction, as an install leaves them. A running Vite writes `.vite` whenever it optimises a dependency.
- **The archive is larger than `MAX_DEPENDENCY_ARCHIVE_BYTES` (128 MiB).** That bounds what one reopen downloads and holds in memory. Such a project installs on every reopen, as every project did before.

The write is never awaited, never rejects, and its failure is never shown to anyone. `OpenedProject.dependencyCacheWrite` exposes it so tests can wait on it.

### D3: The restore is one command, and what is independent overlaps

`restoreBundle` uploads the bundle, then runs a single `&&`-chained script: verify, clone, select HEAD, configure, swap `.git`, reset, clean. It takes an optional `probe`, a command printing one line, which runs before and after the swap inside that same script. Git's output goes to stderr, so stdout holds only the probe's two lines. A failure anywhere in the chain is still the single `exec_failed` it always was, and the steps before the swap still run before anything in the live repository is touched.

For a template project, the snapshot row, the bundle and the dependency archive are read **while the sandbox is being created**. The archive is uploaded **while the restore script runs**. Round trips per reopen:

| Path | Before | After (on the critical path) |
|---|---|---|
| Dependencies unchanged from the template | 10 | 3: `create`, upload, restore |
| Dependencies from the archive | 11 plus an install | 5: `create`, upload ‖ archive upload, restore, extract |
| Cache miss | 11 plus an install | 4 plus the install, then 3 in the background |

`restore.test.ts` asserts these counts and fails if they grow.

**The cost:** a storage outage now creates a sandbox and destroys it at once, where before it created nothing. That sandbox is billed for seconds, and the capacity reservation that covered it is released as before. **Imported repositories keep the old order.** Their first bundle can wait minutes behind the broker's transfer slots (`acquire-sandbox.test.ts` covers this), and a sandbox created alongside that wait would be billed for it and could outlive its own deadline.

## Consequences

- No new env keys. The archive lives in the bucket `R2_*` already names, under the project's own prefix.
- Storage is at most one archive per project: about 33 MB for a project that added a little, capped at 128 MiB. It is replaced when the inputs change and deleted with the project. An R2 lifecycle rule is not needed for the bound. One on `projects/*/dependencies.tar.gz` would only trim archives of projects that are never deleted, and an expired archive costs one install.
- A reopen holds the archive in memory twice, once downloading and once uploading. Streaming both ends is a follow-up: E2B's `files.write` accepts a `ReadableStream`, and the S3 body offers `transformToWebStream()`. It would need a streaming method on both ports, and `r2-object-store.ts` is being changed by #220.
- The probe runs `bun`, `node`, `git`, `sha256sum` and `cut` in the image. If any of them is missing, the result is an install, never a wrong archive.
- Reversing D1 means deleting the cache paths in `openProject`. The probe can stay, since the baked-template comparison still needs it. Reversing D3's overlap means awaiting the fetch before `createSandbox`.

### Follow-ups, not built

- **Pause recently idle sandboxes** instead of destroying them, over this cache rather than instead of it. See (b) for what that touches.
- **Incremental bundles.** A snapshot is still the whole history every turn. GOTCHAS records why: a restore must depend on one object. A chain with periodic full bundles could keep that property, but it changes teardown, which another change is moving off the lease.
- **Streaming** the bundle and the archive, as above.
