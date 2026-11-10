# ADR-0032: A reopen does not reinstall, and its round trips overlap

**Status:** Accepted, 2026-11-09; D4 to D6 added 2026-11-10 after review. Built and tested on fakes and against a real shell, git, tar and Node, with the offline install checked against real Bun. The real-E2B round trip (`restore.integration.test.ts`) has been written for it but not run, so no reopen has been timed on a real sandbox.

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

- **Something other than the committed inputs went into the install.** See D4. The install command decides this itself and writes the record below only when nothing did.
- **The tree moved after the install.** The install leaves a record listing the packages present when it finished. After packing, the archive command checks that no entry under `node_modules` has an inode change time (`ctime`) newer than that record and that the package list is unchanged. It checks `ctime` rather than `mtime` because extracting a tarball over the tree, or `cp -p`, writes new bytes under an old `mtime`, and nothing can set a `ctime` back. Edits, additions and removals are all refused. Tool caches (`.vite`, `.vite-temp`, `.cache`, `.tmp`) are left out of the archive, ignored by the check, and carried across an extraction, as an install leaves them. A running Vite writes `.vite` whenever it optimises a dependency.
- **The archive is larger than `MAX_DEPENDENCY_ARCHIVE_BYTES` (128 MiB).** That bounds what one reopen downloads and holds in memory. Such a project installs on every reopen, as every project did before.

The write is never awaited, never rejects, and its failure is never shown to anyone. `OpenedProject.dependencyCacheWrite` exposes it so tests can wait on it.

### D3: The restore is one command, and what is independent overlaps

`restoreBundle` uploads the bundle, then runs a single `&&`-chained script: verify, clone, select HEAD, configure, swap `.git`, reset, clean. It takes an optional `probe`, a command printing one line, which runs before and after the swap inside that same script. Git's output goes to stderr, so stdout holds only the probe's two lines. A failure anywhere in the chain is still the single `exec_failed` it always was, and the steps before the swap still run before anything in the live repository is touched.

For a template project, the snapshot row, the bundle and the dependency archive are read **while the sandbox is being created**. The archive is uploaded **while the restore script runs**. Round trips per reopen:

| Path | Before | After (on the critical path) |
|---|---|---|
| Dependencies unchanged from the template | 10 | 3: `create`, upload, restore |
| Dependencies from the archive | 11 plus an install | 5: `create`, upload ‖ archive upload, restore, extract |
| Dependencies from the package cache (D4) | 11 plus an install | 6: `create`, upload ‖ archive upload, restore, extract, offline install |
| Cache miss | 11 plus an install | 4 plus the install, then 3 in the background |

`restore.test.ts` asserts these counts and fails if they grow.

**The cost:** a storage outage now creates a sandbox and destroys it at once, where before it created nothing. That sandbox is billed for seconds, and the capacity reservation that covered it is released as before. **Imported repositories keep the old order.** Their first bundle can wait minutes behind the broker's transfer slots (`acquire-sandbox.test.ts` covers this), and a sandbox created alongside that wait would be billed for it and could outlive its own deadline.

### D4: What is archived depends on what decided the install

A key describes an install only if the install read nothing but what the key hashes. The first version of this decision assumed that and checked it by reading the key again after the install. Review found two ways that check could not work:

- **An install that rewrote its own inputs.** A key read from `git ls-tree HEAD` does not change when `bun install` rewrites `bun.lock` in the working tree, because HEAD did not move. The rewritten install was stored under the committed key.
- **An install that ran a lifecycle script.** A script can read any file in the project and write anywhere. Prisma's client package, for one, generates code from the project's schema. The schema is not in the key, so a changed schema reused stale generated code. And output the script wrote outside `node_modules` was not in the archive, so a cache hit lost it.

No key can name what an arbitrary script reads. So for those projects the tree is not cached at all. What is cached is what the install downloaded, which depends only on the lockfile. The install command says which of three cases it was, in the same round trip as the install:

- **No archive**, when the inputs or any committed file differ from HEAD before or after the install (`git status --porcelain`, with `--ignored --untracked-files=all` over the input paths). That covers a rewritten lockfile, a migrated `bun.lockb`, an edited `package.json`, and an input the template left that nobody committed. D6 says what the open does then.
- **`node_modules`**, when the tree is clean and nothing else could have decided what the install wrote:
  - the root `package.json` declares no install lifecycle script (`preinstall`, `install`, `postinstall`, `preprepare`, `prepare`, `postprepare`), no `workspaces`, no local package (`file:`, `link:`, `workspace:`, `portal:`, `git+file:`, a path, or a tarball by path) in any dependency field, `overrides` or `resolutions`, and no patch outside `patches/`;
  - the install brought in no package with an install script of its own, or a `binding.gyp`, that was not already in the tree at the same path, name and version. A small Node script lists them before and after. One already there is the template's: it ran when the image was built, and an install that leaves it in place does not run it again.

  A reopen extracts this archive and installs nothing.
- **`packages`**, when the tree is clean but one of those rules fails. The archive is every entry of Bun's package cache (`bun pm cache`) newer than a mark the install left just before it ran: the package directories and manifests it downloaded. Bun keeps a scoped package a level down, in `@scope/`, so inside a scope directory it is the scoped packages that are compared with the mark, never the directory as a whole. The image's cache already has scopes such as `@types`, and a package the install added there must still be found. Entries the image already had are left out, since every sandbox has them. A reopen adds the entries to the cache, merging scope directories and keeping any entry already there, and runs `bun install --offline --frozen-lockfile`. **That install runs the project's scripts again, on the tree being opened**, so their output is exactly what any install would produce, inside `node_modules` or outside it. `--offline` means no network: Bun fails, rather than fetching, if anything is missing. `--frozen-lockfile` means nothing is resolved differently than it was online. If the offline install fails for any reason, the reopen installs normally, which is the miss path. **Both installs copy files out of Bun's cache (`--backend=copyfile`) rather than linking them.** On Linux Bun hardlinks by default, and a script that edits a dependency's file in place would then edit the cached copy as well. The archive would carry the edit, and the next reopen would run the script again on top of it. Measured on real Bun 1.4.2: with `hardlink`, a `postinstall` appending one line left two after an offline reopen; with `copyfile`, one, as a fresh install leaves.

**This is not "no install" for those projects.** The user chose it over two alternatives (2026-11-10). One was installing at teardown or after each turn under a key of the whole committed tree. The other was accepting a full install on every reopen. The offline install does no resolution and no download; what it costs is linking plus whatever the scripts themselves take. Measured on a developer's Mac with Bun 1.4.2: an offline install of one restored package took 79 ms. It failed cleanly with an empty cache, and re-ran a `postinstall` that read a changed source file, producing the new output.

Archives carry a version-3 header naming their kind. Version 1 and 2 headers are read as a miss, so every older archive is replaced once.

### D5: An optional archive never holds up a reopen, and never outlives its project

**The archive is downloaded beside the restore, but waited for only when the keys say it is needed**, and then for at most `DEPENDENCY_ARCHIVE_WAIT_MS` (30 s) or until the open is cancelled. The store's client has no deadline of its own, so before this a silent storage connection held every snapshot reopen, including the common one whose template dependencies already matched. Once the open stops waiting, an archive that finishes downloading later is not uploaded into the sandbox. One whose upload had already started finishes into a scratch file that nothing reads.

**A late upload cannot leave an archive behind a deleted project.** The upload runs off any lease, so a project can be deleted while it is in flight. `deleteProject` removes the archive before the rows (so a failed delete can be retried) and again after them. The upload, once it has landed, asks the snapshot store whether the project still has a snapshot, and deletes its own archive if it has none or the store cannot say. Every order of those steps ends with no archive for a deleted project. The gaps are failures at the wrong moment: the second, best-effort delete failing for an upload that checked before the rows went; an upload the client reports as failed that the store in fact kept, which skips the check; and the upload's own delete failing.

### D6: An install that changes committed files opens with a warning

A restore's install may itself rewrite a committed file: a stale `bun.lock`, or a root script regenerating a tracked file. The tree then cannot be both what was committed and what its dependencies were installed for. Resetting the files would leave dependencies resolved from inputs the tree no longer has; failing the open would put an error page where a working project could be. The open therefore keeps the install, and `OpenedProject.warning` names the changed files: the first five, and how many more. The install command lists them from `git status --porcelain --untracked-files=no` after it ran; the tree was clean before, since the restore had just reset it. No archive is stored for such an install. The user chose this over failing the open (2026-11-10).

## Consequences

- An offline install that times out, say on a hanging `postinstall`, is followed by an online one with the same `RESTORE_INSTALL_TIMEOUT_MS`, so the worst case for such a reopen is twice that deadline. A cancel still ends it at once.
- No new env keys. The archive lives in the bucket `R2_*` already names, under the project's own prefix.
- Storage is at most one archive per project: about 33 MB for a project that added a little, capped at 128 MiB. It is replaced when the inputs change and deleted with the project, including by a delete that raced the upload (D5). An R2 lifecycle rule is not needed for the bound. One on `projects/*/dependencies.tar.gz` would only trim archives of projects that are never deleted, and an expired archive costs one install.
- A reopen holds the archive in memory about three times at once: the download, the decoded copy and the upload's. Streaming both ends is a follow-up: E2B's `files.write` accepts a `ReadableStream`, and the S3 body offers `transformToWebStream()`. It would need a streaming method on both ports, and `r2-object-store.ts` is being changed by #220.
- The probe runs `bun`, `node`, `git`, `sha256sum` and `cut` in the image, and the install's eligibility check runs `git` and `node`. If any of them is missing, the result is an install, never a wrong archive.
- Reversing D1 means deleting the cache paths in `openProject`. The probe can stay, since the baked-template comparison still needs it. Reversing D3's overlap means awaiting the fetch before `createSandbox`.

### Follow-ups, not built

- **Pause recently idle sandboxes** instead of destroying them, over this cache rather than instead of it. See (b) for what that touches.
- **Incremental bundles.** A snapshot is still the whole history every turn. GOTCHAS records why: a restore must depend on one object. A chain with periodic full bundles could keep that property, but it changes teardown, which another change is moving off the lease.
- **Streaming** the bundle and the archive, as above.
