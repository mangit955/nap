# Deploying Nap

**Live:** the app is at <https://nap-tawny.vercel.app> and the API at
<https://nap-api.onrender.com>.

Two services and four accounts. The web app is on Vercel, the API on Render, and the
API is the one that holds all the state and spends all the money.

| Piece | Where | Notes |
|---|---|---|
| `apps/web` | Vercel | Next 16, root directory `apps/web` |
| `apps/api` | Render | This repo's `Dockerfile`, **one replica as deployed, which is a choice and no longer a rule** — see below |
| `apps/api`'s worker | Render | The *same image*, started as `bun apps/api/src/worker.ts`. Also one as deployed, also scalable |
| `apps/api`'s reaper | Render | The same image again, `bun apps/api/src/reaper.ts`, **exactly one replica** |
| Postgres | Render | `nap-db`, in the same region as the services, reached on Render's private network |
| Object storage | Cloudflare R2 | Snapshots of projects nobody is using |
| Sandboxes | E2B | Created per project, billed by the second |
| Model | OpenRouter | `openai/gpt-5.6-luna` by default |

## Render

`render.yaml` is the deployment: the three services and their database, with every secret
`sync: false`. `render blueprints validate render.yaml` checks it. It replaced Railway, whose
trial accounts stopped accepting deploys or even new projects; `.railway/railway.ts` still
describes that deployment, and the sections below that name Railway describe the same three
processes on it. What is different here, and why:

- **The worker drains in 270 seconds, not 600.** Render allows at most 300 between SIGTERM and
  SIGKILL (`maxShutdownDelaySeconds`), so `NAP_DRAIN_TIMEOUT_SECONDS` has to fit inside it. A
  turn still running 270 seconds into a deploy is aborted rather than killed mid-write. Two fixed
  tails come after the drain and have to fit too: the turn worker's 10-second grace for the turns
  it aborts, then the thumbnail lane's 10-second grace for pictures in flight. 270 + 10 + 10 leaves
  about 10 seconds for closing the listener and the database connections. Between the two graces
  the worker stops listening for cancel wake-ups, which normally answers at once but is given up
  after 5 seconds, so a channel that hangs there spends half of that margin.
- **Migrations run as the worker's pre-deploy command**, once per release and before the new API
  takes traffic, not at boot. The API repeats the idempotent migration as a safeguard for manual
  deploys. The release script deploys the worker first, so its schema is ready before it boots.
  Migration `0021` runs `create extension if not exists pg_trgm` for sidebar search. Render and
  Neon let the database owner create it (it is a trusted extension since Postgres 13); a role
  that cannot fails that release's migration before anything new takes traffic. It also builds
  two partial indexes on `events`, each reading the whole table, inside the one transaction
  drizzle migrates in. That takes a SHARE lock on `events`: while they build, and until the
  migration commits moments later, every event append waits, and reads carry on. Only then does
  it take its brief locks on `users` (for a foreign key), `repository_jobs` and `projects`; the
  `ALTER TABLE`s also stop reads (the sidebar, admission, the claim), which is why they come last.
  `0022` alters `projects` again in the same transaction, just as briefly. An index on
  `sessions(project_id)` is deliberately left to a later release's own migration: an append
  updates `sessions` before it inserts into `events`, so building that index here, after the
  `events` scans, deadlocks with any append waiting on them. One such cycle is left: a session
  deleted during the scans holds `projects` while its cascade waits on `events`, and the migration
  can then fail with `deadlock detected`. It rolls back whole, so run it again.
- **The release that added the sidebar card's fields and model titles (`0021`, `0022`) is read
  strictly by what it replaces.** Event payloads and the session list are strict schemas, so a
  browser tab opened before the deploy, and an API or reaper pod not yet rolled, reject what the
  new code writes: `turn.completed` carrying `diff`, the list's new fields, and the new
  `project.renamed` event. Such a tab stops refreshing the sidebar and can show a finished turn as
  still running; reload open tabs once the deploy is done. A rename served by an old API pod
  during the rollout leaves `name_source` at `seed`, so that name can still be replaced by the
  automatic title.
- **One database URL serves both connections.** Render Postgres has no pooler in front of it, so
  `DATABASE_URL` and `NAP_LISTEN_DATABASE_URL` are the same internal connection string, and the
  database accepts no connections from outside Render.
- **The worker is the 2 GB plan.** It runs Chromium for the preview screenshots; the Kubernetes
  manifests request 1 GiB for the same process, and 512 MB is where it runs out.
- **GitHub Actions releases production after CI passes on `main`.** Render's own auto-deploys
  stay off. The `production` job deploys the worker, API and reaper in that order, then Vercel,
  using the same commit SHA throughout. See [Release production](#release-production).
- **The free database expires after thirty days.** Upgrade `nap-db` to `basic-256mb` before then,
  or its data goes with it. Render Postgres rather than Neon's free tier because three processes
  each hold a permanent `LISTEN` connection, so a Neon compute never scales to zero and its free
  quota runs out within the month.

## Release production

Add these repository Actions secrets at
<https://github.com/mangit955/nap/settings/secrets/actions> before merging the release workflow:

- `RENDER_API_KEY`: a persistent API key from [Render Account Settings](https://dashboard.render.com/u/settings#api-keys).
  The token saved by `render login` expires and is unsuitable for CI.
- `VERCEL_TOKEN`: an access token for the team containing the `nap` project, from
  [Vercel account tokens](https://vercel.com/account/tokens). A CLI login's refreshable token
  is unsuitable for CI. Rotate the Actions secret before the access token expires.

Merging to `main` runs both CI jobs before the production job. `apps/web/vercel.json` disables
automatic Git deployments from `main`; preview branches remain enabled. The release script
uses Vercel's deployment API with an explicit SHA instead of a branch-based deploy hook, so
another merge cannot change which frontend is deployed.

`scripts/production-release.ts` checks both providers' credentials and confirms all three
Render services have auto-deploy disabled before changing anything. It also requires the worker's
Pre-Deploy Command to be `bun packages/db/scripts/migrate.ts`, read from Render's service
configuration rather than assumed from `render.yaml`. Before merging this release, set that
command on `nap-worker` in Render Settings. Triggering a deploy does not apply Blueprint changes;
without this setting, the script stops before deploying any service.

The script deploys the worker first. Its pre-deploy command applies pending migrations before
new workers boot. It waits for that deployment to be `live`, then deploys the API, waits for
`/readyz` to report `ok`, deploys the reaper, and starts Vercel. The API retains the same
idempotent migration command as a safeguard for manual API deploys.
[Render's deployment sequence](https://render.com/docs/deploys#zero-downtime-deploys) shuts down
old instances before completing the deployment, including forced termination after the shutdown
delay. Waiting for the worker deploy to complete therefore removes old claimers before the new
API can admit a plan intent. This relies on Render's lifecycle contract; fakes test the order
and wait, not the hosted shutdown behavior.

The script verifies each deployed commit and waits for Vercel to reach `READY`. Each deployment
has a twenty-minute timeout. A failed step stops the release; earlier successful steps remain
deployed. Investigate the failed service before retrying. No database rollback runs automatically.

To retry, run the **CI** workflow with **Run workflow**, selecting `main`. Releases on `main`
are serialized and newer merges cannot cancel an active release. A retry reuses a Render
deployment at the requested commit if it is live or still deploying. Vercel can rebuild the
same commit on a retry.

For a manual release, export those two credentials in your shell and run from the repo root:

```sh
bun run scripts/production-release.ts <full-40-character-commit-sha>
```

Keep Render auto-deploy off and run the manual command without a concurrent Actions release.
For a release that changes the durable event contract, follow the controlled rollout below
instead of relying on the normal rolling deployment sequence.

**A desktop build change requires a controlled rollout before merging.** A merge to `main`
automatically releases, but the release script neither publishes the E2B template nor drains
computer reservations before replacing the runtime. If `packages/sandbox/src/desktop-build.ts`
changes, complete the [desktop build rollout](#deploy-a-desktop-build-change) before merging or
starting a manual release. Publishing alone is insufficient: the new runtime also refuses to
drain input scopes on old images, so a held reservation can block the project's turns and closure.

The [Render deploy API](https://api-docs.render.com/reference/create-deploy),
[Vercel deployment API](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment),
and [Vercel Git configuration](https://vercel.com/docs/project-configuration/git-configuration)
describe the provider settings used here.

## Three entrypoints, one image

The binary is split (`docs/scaling-design.md` §4 and §13). One image, three commands:

| | Command | Serves | Executes | Replicas |
|---|---|---|---|---|
| API | `bun apps/api/src/index.ts` (the Dockerfile's default) | HTTP, WebSockets, auth, admission | nothing | as many as you like; one on Railway today |
| Worker | `bun apps/api/src/worker.ts` | nothing | turns | as many as you like; one on Railway today |
| Reaper | `bun apps/api/src/reaper.ts` | nothing | the idle sweep, capacity reconciliation, the rate-event sweep, the janitor, and with a GitHub App configured the GitHub sweep | **exactly one** |

All three call `bootNap` in `apps/api/src/boot.ts` and differ only by the role they pass, so
there is one composition rather than three that drift. A turn reaches a worker through
`turn_requests` and nothing else; there is no call between any of the processes.

**Deploying this needs a Railway service each, and the API stops running turns without the
worker.** Same repo, same Dockerfile, same variables — what differs is the start command, and
**the healthcheck path must be empty for the two that serve nothing**, because whether a worker
is working is a question about queue depth.

**That last point is why the healthcheck is declared per role, and finding out why cost a broken
deployment.** A worker that inherits `/health` serves nothing, never answers, and the deployment
fails at the healthcheck step — **after** the process has booted correctly and logged
`worker claiming`, which is what makes it confusing: the logs show a working worker and the deploy
shows a failure.

| Service | Start command | Healthcheck |
|---|---|---|
| `nap-api` | the Dockerfile's default | `/health` |
| `nap-worker` | `bun apps/api/src/worker.ts` | none |
| `nap-reaper` | `bun apps/api/src/reaper.ts` | none |

**All three are declared in `.railway/railway.ts`, and that file is the only place they are.**
It is Railway's Infrastructure-as-Code: one TypeScript module describing the project, compiled and
diffed against the live deployment.

```bash
railway config plan     # what Railway would change; touches nothing
railway config apply    # apply it — asks first unless you pass --yes
```

It needs the `railway` SDK (a root devDependency) and Railway CLI ≥ 5.42.1.

**This replaced three files, and the mechanism they used is gone.** `railway.json`,
`railway.worker.json` and `railway.reaper.json` worked by pointing each service at its own file
through Railway's *Config-as-code* setting (`railwayConfigFile`). That setting now fails with
*"Config as Code (railway.json / railway.toml) is deprecated"*, and the files themselves stop being
read on **2026-12-01**. A service created from this repo while a root `railway.json` was the only
config silently builds with Railpack, ignores the `Dockerfile`, and inherits no start command — so
the worker and the reaper come up as second copies of the API, which is exactly the failure the old
table existed to prevent.

`test/railway.test.ts` compiles that config and checks the claims that fail silently: the three
services exist, only the API is healthchecked, the reaper is one replica, no credential has a
literal value, and the drain is longer than the application's own. Each rule is also run against a
synthetic service that breaks it, because a rule nobody has watched fail is not known to work.

One thing must be true first:

- **`NAP_EVENT_BUS=postgres`.** A worker publishing to an in-process bus announces a turn to
  nobody: every socket watching it is on the API pod. Turns would run perfectly while every
  chat pane sat still, so **the worker and the reaper both refuse to boot without it** rather
  than letting that be discovered from the browser — the reaper publishes too, when it stops a
  preview or closes out an interrupted turn. See below for the `LISTEN` pooler caveat.

**The reaper is one replica and says so twice** — `numReplicas: 1` *and* an advisory lock, for the
reasons below.

Locally, `bun run dev`, `bun run dev:worker` and `bun run dev:reaper` are the three, against one
database and one `apps/api/.env`.

## Scaling: the rule that used to be here, and what replaced it

This document forbade scaling the API past one instance, and gave four reasons: the in-process bus,
the in-memory registry and queue, the per-process rate limiter, and the in-process reaper. **Four of
the five things in that list were retired outright; the fifth was moved rather than removed.** The
reaper is still exactly one — what changed is that it is now a process of its own instead of a
`setInterval` inside every API pod, which is what let the other four go. None of them was retired by
somebody deciding the risk was acceptable. The proof is a run, not a paragraph: `docs/scaling-cluster.md` is the k6 ramp to 100
concurrent turns against three API pods, two-to-four workers and one reaper, with both autoscalers
live. **Its figures live there and are not repeated here.**

| The old reason | What replaced it |
|---|---|
| **The in-process bus** — `InProcessEventBus` fanned events out to sockets inside one process, so a browser on pod A never saw a turn that ran on B | `PostgresNotifyEventBus`, under `NAP_EVENT_BUS=postgres`. The notification carries `{sessionId, seq}` and the pod reads the events out of the durable log; a 2s catch-up poll makes the notification optional for correctness. See `docs/adr/0010` |
| **The in-memory registry** — `TurnRegistry` meant a cancel landing on pod A could not reach a turn on pod B, and `isBusy` went blind | Cancellation is a row. `cancel_requested` on `turn_requests` reaches an executing turn on any pod within one lease renewal (≤15s), and a `pg_notify` after the commit makes the worker renew at once (`docs/adr/0023`); the registry survives only as the same-process fast path. **Busy** is `TurnQueue.anyLeased` — a `state = 'leased'` query — so close, delete and the idle sweep all get the same answer cluster-wide |
| **The in-memory queue** — `SessionQueue` serialised a session's turns inside one process, so two pods would run two turns for one session and the project would end up with two sandboxes | `turn_requests` plus per-session **leases**, exclusive by the partial unique index `unique (session_id) where state = 'leased'`. One in-flight turn per session cluster-wide, adjudicated by Postgres rather than by every caller remembering. See `docs/adr/0009` |
| **The per-process rate limiter** — N pods meant N times the free-tier allowance | `turn_rate_events`: one row per accepted turn, counted over a rolling hour in Postgres. `NAP_FREE_TURNS_PER_HOUR=5` means five whether one process is running or twelve. The sandbox ceiling moved the same way, to `sandbox_reservations` taken *before* creation |
| **The in-process reaper** — N pods meant N concurrent sweeps tearing the same project down twice | **Not retired: moved.** The sweeps left the API process entirely and became `apps/api/src/reaper.ts`, of which there is exactly one. That is what makes the row above it safe to scale — see below |

**The reaper is still exactly one, and that pin is permanent.** It is what snapshots an idle
project and destroys its sandbox — the only thing standing between an abandoned tab and an E2B
bill — and it also reconciles the sandbox ceiling, reclaiming slots held by a process that died
mid-creation and destroying sandboxes E2B is running that no project references. Two of them would
do all of that twice, the second teardown landing on a sandbox that is already gone. A rolling
update runs two for a few seconds whatever the replica count says, so it also takes a
`pg_try_advisory_lock` and skips any tick it does not hold.

That also rules out anything that sleeps the *reaper*: a sleeping one is not reaping while the
sandboxes it should have cleaned up keep billing. Leave app sleeping off on every service.

**What is deployed is still one API and one worker, and that is now a sizing choice.**
`.railway/railway.ts` pins each at one replica. `NAP_EVENT_BUS` is already `postgres` on all three
services — it has to be, since the worker and the reaper refuse to boot without it — so scaling
this deployment is now the one edit rather than the two it used to be. **Raising the replica count
while the bus is still `in-process` is exactly the failure the old rule described**, and nothing
will tell you: the turns run and the chat panes stop moving. That is worth remembering because the
*default* is still `in-process`; it is set here, not inherited. The multi-pod shape lives in
`infra/k8s/`, where both are set in the manifests.

The event log is durable and ordered in Postgres, so a restart loses nothing either: a client
reconnects with `?afterSeq=` and gets exactly the gap.

### Turning it on

`NAP_EVENT_BUS=postgres` swaps `InProcessEventBus` for `PostgresNotifyEventBus`. Three things to
know when you do:

- **`LISTEN` cannot go through a connection pooler.** It is session state, and a transaction
  pooler hands the next statement to whichever backend is free — so the `LISTEN` lands on a
  connection that is returned to the pool, and the process hears nothing while every query it
  runs keeps working. Behind Neon's pooled endpoint (or PgBouncer in transaction mode), set
  `NAP_LISTEN_DATABASE_URL` to the **direct** endpoint. Omit it otherwise. The reaper's advisory
  lock is session state too and uses the same variable.
- **`/readyz` gains a `listener` check and fails on it**, so a pod whose fanout has degraded to
  the 2s catch-up poll leaves the rotation while another pod's has not. `/livez` does not: the
  connection reconnects on its own, and restarting the process would only drop the sockets it
  still had. A `503` from `/readyz` with `{"checks":{"database":"ok","listener":"down"}}` means
  exactly this, and usually means the listener is going through the pooler.
- **The stop button rides on the same listener, and costs it no connection.** Cancel wake-ups
  share the socket the fanout already holds. A worker whose listener is down still stops a turn,
  at its next lease renewal rather than at once. A worker has no `/readyz`, so the only symptom
  there is a slow stop button.
- **So does claiming.** An idle worker waits for a claim wake-up on the same socket, announced
  by whatever wrote the request, and otherwise asks the queue only every
  `NAP_WORKER_FALLBACK_POLL_SECONDS` (5 s). That is about 0.2 claim queries a second per idle
  worker, down from 10. While the listener is down, which the event bus's echo detects, the
  worker polls every 100 ms as it used to, so turns still start promptly and the database pays
  the old idle load. Broadcasts coalesce at a 100 ms minimum round gap; a worker's own
  completion refills immediately. During the existing worker-first rollout, old API/reaper
  writers do not announce yet, so new workers can start turns up to one fallback interval late.
  Keep the release script's deployment order for event compatibility. See `docs/adr/0027`.

### What each process scales on

Not CPU, for either of them, and for the same reason in two shapes: a turn is almost entirely
waiting on the model and the sandbox, and an idle socket costs a file descriptor.

| | Signal | Bound |
|---|---|---|
| Worker | **Queue depth** — `count(*) from turn_requests where state in ('queued','leased')`, divided by one pod's worth of work. KEDA's `postgresql` scaler, because a plain HPA cannot read Postgres | `maxReplicaCount` is derived from `NAP_MAX_SANDBOXES_TOTAL`, so **no autoscaler decision can outrun the thing that bounds the bill**. At the base ConfigMap's ceiling that derivation puts min and max both at 2, so the scaler is correctly wired and has nothing to move until the ceiling is raised |
| API | **Open sockets** — `nap_ws_connections`, through Prometheus and prometheus-adapter, with CPU as a secondary trigger | Nothing but the replica count; API pods spend no money |

`infra/k8s/base/scaledobject-worker.yaml` and `hpa-api.yaml` are those two, they carry the actual
targets and windows, and `infra/k8s/README.md` says what each one guards — **read the values there
rather than from a copy here.** The shape worth knowing without opening them: the way up is quick
and the way down is slow, because removing a worker mid-turn is the same event as losing one and
scaling in an API pod costs every socket on it a reconnect.

### What happens when a pod goes away

A worker between `SIGTERM` and exit **drains**: it stops claiming, keeps renewing the leases it
already holds so the janitor does not orphan progressing work, and waits out
`NAP_DRAIN_TIMEOUT_SECONDS` for the turns in flight. Past that the rest are aborted through their
`AbortController` — a clean stop that commits nothing and closes each job *abandoned*, never a
kill.

**The platform's grace period must comfortably exceed that timeout**, or the drain is a kill and
every turn in flight costs a human a reopen. The Kubernetes manifests set
`terminationGracePeriodSeconds: 900` around a 600-second drain, and the pairing is asserted in
`test/k8s.test.ts` rather than left to whoever edits one of them. The load run demonstrated the
*mechanism* at a much shorter drain than the manifests' — it scaled workers away mid-plateau with
turns in flight and lost none of them — which is evidence that draining works, and not evidence
about the 900-around-600 arithmetic itself.

**On Railway that grace period is zero unless you set it**, which makes this the one place the
platform's default silently cancels the application's design: `SIGTERM` is followed immediately by
`SIGKILL`, so the worker stops claiming, renews its leases, and is killed mid-sentence anyway. The
turns in flight are then the janitor's problem rather than the drain's — they are recovered, but
each one cost somebody a reopen, on every single deploy. `.railway/railway.ts` sets
`drainingSeconds: 900` on the worker for the same 900-around-600 reason as the manifests, and
`test/railway.test.ts` asserts that it exceeds `NAP_DRAIN_TIMEOUT_SECONDS`. Railway also exposes
this as the `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` variable; the config file is where it is decided.

An API pod is cheaper: stop accepting, close each socket with a normal close code, exit. Clients
reconnect with `?afterSeq=` and lose nothing, because the log is the delivery.

A worker that dies *without* a `SIGTERM` is the janitor's: past the lease's grace window it marks
the request `orphaned` and writes the terminal event the interrupted turn never got, so the chat
pane is told rather than spinning. It never requeues — nothing re-executes with nobody watching.

## Repair ownership rollout

The worker now writes `user.message.payload.repair`. Old strict API, fanout, reaper and worker
readers cannot read those durable rows. Browser tabs are different: the new API sends legacy-safe
prompts unless a socket opts in with `repairOwnership=1`, including replay and reconnect. Existing
tabs need no refresh for this field. New web assets alone are not the compatibility barrier.
There is no database migration. Keep the same database and event log throughout.

For the Railway services declared in `.railway/railway.ts`, use a controlled service-by-service
release, not simultaneous Git auto-deploys:

1. Disable automatic deploys for `nap-api`, `nap-reaper` and `nap-worker` in their service source
   settings for this release. Record the deployed commit for each and the release commit. Keep
   the worker on its old commit while deploying the release to `nap-api` and `nap-reaper` through
   each service's Deploy action. Wait for the API health check, reaper startup and termination of
   every old API/reaper deployment. Check all regions/replicas, not only the active deployment
   badge. API shutdown closes old sockets; reconnects reach the compatible projection.
2. Remove the active old `nap-worker` deployment through its deployment menu. Preserve the
   configured 900-second draining grace; the worker stops claiming on SIGTERM and renews held
   leases during its 600-second drain. Wait until every old worker instance has exited. If a
   worker is killed or its status is uncertain, keep new workers stopped, resolve its process
   status, and let the updated janitor finish expired leases. Do not treat an elapsed timer or
   an empty queue alone as evidence that an old reader has exited.
3. With all API/reaper instances on the release and no old worker alive, manually deploy that
   exact release commit to `nap-worker`. Queued admissions can wait during this pause; they are
   not requeued or replayed. Confirm the worker startup identifies the release before restoring
   automatic deploys. Deploy the matching web assets on Vercel. Old and new browser tabs remain
   supported by socket projection.
4. Check a session's replay in an old tab and a refreshed tab, including a repair prompt and
   reconnect cursor. Record process identities and results in the release record. These steps
   are a rollout procedure, not a claim that this deployment has been exercised.

For the repository's Kubernetes deployment, the equivalent commands below use the existing
Deployments and KEDA object. Set `NAP_RELEASE_IMAGE` to the immutable image digest for this
release. Do not apply the whole kustomization during this sequence, since it would update all
roles together. Pause any external GitOps controller for these objects first.

```sh
kubectl -n nap set image deployment/nap-api api="$NAP_RELEASE_IMAGE"
kubectl -n nap rollout status deployment/nap-api --timeout=180s
kubectl -n nap set image deployment/nap-reaper reaper="$NAP_RELEASE_IMAGE"
kubectl -n nap rollout status deployment/nap-reaper --timeout=180s
kubectl -n nap get pods -l app.kubernetes.io/name=nap -o wide
# Confirm every old API/reaper pod has terminated before proceeding.
kubectl -n nap delete scaledobject nap-worker
kubectl -n nap scale deployment/nap-worker --replicas=0
kubectl -n nap wait --for=delete pod -l app.kubernetes.io/component=worker --timeout=960s
# Confirm no old worker pod is running, including terminating or unreachable nodes.
kubectl -n nap set image deployment/nap-worker worker="$NAP_RELEASE_IMAGE"
kubectl -n nap scale deployment/nap-worker --replicas=2
kubectl -n nap rollout status deployment/nap-worker --timeout=180s
kubectl apply -f infra/k8s/base/scaledobject-worker.yaml
```

Use the deployment's recorded worker replica target if it differs from the base manifest's two.
Do not advance after a failed barrier. Once any new metadata is durable, rollback must retain
compatible backend readers. A prior binary that rejects the field is not a safe rollback image;
stop producers and roll forward with compatible readers instead of deleting event payloads.
The activity observation semantics and legacy recovery limits are in
[ADR-0017](adr/0017-repair-prompts-record-request-ownership.md).

## First deployment

### 1. A production database

Create a new Neon database or branch — do not point production at the development one,
which still holds pre-authorization rows that belong to nobody.

```bash
DATABASE_URL='<prod url>' bun run db:migrate
```

Migrations are deliberately not run at boot: three processes racing one schema change is bad
enough at one replica each and worse at a dozen, and a schema change is a decision rather than a
side effect of a restart. On Kubernetes it is `infra/k8s/base/job-migrate.yaml`, for the same
reason.

### 2. The API on Railway

`railway config apply` builds all three services from `.railway/railway.ts` — the Dockerfile, the
start commands, one replica each, the healthcheck on the API alone. What it deliberately does not
carry is the credentials, which are `preserve()` there and must be set on the services:

```
DATABASE_URL              the Neon URL from step 1
NAP_LISTEN_DATABASE_URL   the same database's direct endpoint — see the LISTEN caveat above
E2B_API_KEY
OPENROUTER_API_KEY
BETTER_AUTH_SECRET        openssl rand -base64 32 — a fresh one, not the dev value
NAP_KEY_ENCRYPTION_SECRET openssl rand -base64 32 — must decode to exactly 32 bytes
R2_ACCOUNT_ID R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
```

`NODE_ENV`, `NAP_API_URL`, `NAP_WEB_ORIGIN` and `NAP_EVENT_BUS` are in the config file rather than
here, because none of them is a secret and all four are things a reader should be able to see
without opening a dashboard.

**Railway injects `PORT` itself, and it is 8080.** The app defaults to 3001 and follows `PORT`
where it is set, so the only thing that has to know the number is the domain: one pointed at the
wrong port answers **502 while the container logs a healthy boot and serves `/health` internally**.
`.railway/railway.ts` declares the port with the domain so the two cannot drift.

Optionally `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` and the Google pair — both halves or
neither, or boot refuses. Without them those buttons are not offered and email sign-in and
the demo door still work.

Two ways to get this wrong, both quiet:

- **`NAP_WEB_ORIGIN` must match the browser's origin exactly** — no trailing slash, and
  `https`. CORS compares it verbatim, and a mismatch reads as "the API is down".
- **An empty variable is not an unset one.** `GITHUB_CLIENT_ID=` fails boot with
  *"expected string to have >=1 characters"*. Leave optional variables out entirely — including
  `NAP_CHROME_PATH`, which the image sets and a blank platform variable would shadow.

**They must be one site** — under `NODE_ENV=production` every process refuses to boot otherwise.
[One site for both halves](#one-site-for-both-halves) says why, and gives the values.

### 3. The web app on Vercel

**The project's Root Directory must be `apps/web`.** It is a project setting rather than
anything a file in the repo can say, so `vercel link` alone does not set it — the CLI
answers *"No Next.js version detected"*, because it is looking at the workspace root, whose
`package.json` has no `next` in it. Set it in the dashboard, or:

```bash
curl -X PATCH "https://api.vercel.com/v9/projects/<projectId>?teamId=<teamId>" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"rootDirectory":"apps/web","framework":"nextjs"}'
```

Two more things that only show up on a first deployment:

- **A `vercel.json` writes itself into the project's saved settings**, and those outrank a
  later file. A `buildCommand` that was right for one layout and wrong for the next will
  keep being used after you delete it; clear it with the same PATCH, setting
  `buildCommand`, `installCommand` and `outputDirectory` to `null`.
- **`.vercelignore` is not optional here.** The CLI uploads the whole workspace — which is
  correct, since `apps/web` imports `@nap/shared` by source and would not build alone — and
  without that file it also uploads a gigabyte of `node_modules` and any local `.next`,
  which fails on Vercel's 100MB limit.

`apps/web/vercel.json` runs the install from the workspace root with `--ignore-scripts`,
for the same reason the Dockerfile does: the root `prepare` script wants a git repository.

Two variables, both inlined at build time — changing either needs a redeploy, not just a
restart:

```
NEXT_PUBLIC_API_URL     https://nap-tawny.vercel.app/backend
NEXT_PUBLIC_API_WS_URL  wss://nap-api.onrender.com
```

`wss://`, not `ws://`: a page served over https may not open an insecure socket.

### 4. OAuth callbacks

better-auth builds redirect URIs from `NAP_API_URL`, so each provider's app needs
`https://nap-tawny.vercel.app/backend/api/auth/callback/github` (and `/google`).

## One site for both halves

The browser must see the app and the API as one site, or the session cookie is third-party —
and **Safari and Brave drop third-party cookies whatever `SameSite` says**: `POST
/api/auth/sign-in/*` answers 200, the identity row is written, the browser refuses the
`Set-Cookie`, and every request after it is a 401. Chrome and Firefox are fine, which is how it
went unnoticed while the app was on `vercel.app` and the API on `onrender.com` (and `railway.app`
before that), until #86. **Every process now refuses to boot under `NODE_ENV=production` when
`NAP_API_URL` and `NAP_WEB_ORIGIN` are two sites**, and `test/same-site.test.ts` fails CI when
`render.yaml` says they are. `apps/api/src/auth/cross-site.ts` decides what counts as one site.
Both public URLs must use HTTPS. Production images allow HTTP only when both URLs use the same
loopback host, as the local kind clusters do.

**As deployed, the API is published under the web app's own origin.** Both halves are on free
hosts, and a free `vercel.app` name cannot have an `api.` sibling on Render, so
`apps/web/vercel.json` forwards `https://nap-tawny.vercel.app/backend/*` to
`https://nap-api.onrender.com/*` and the browser never talks to Render's host for anything with a
cookie. What that costs, each of which the code already accounts for:

- **`NAP_API_URL` is the public address, path and all** — `https://nap-tawny.vercel.app/backend`.
  OAuth redirect URIs are built from it, so the provider sends the browser back through the
  proxy, where the cookie is. better-auth takes a base URL with a path as the whole of it, so
  `apps/api/src/auth/public-url.ts` gives it `…/backend/api/auth` and shows it each request at
  the address the browser used; `apps/web/src/auth/auth-base-url.ts` does the same for the client.
- **The forward must never cache.** It carries every authenticated response, and a cached one is
  somebody else's: `x-vercel-enable-rewrite-caching: 0` on `/backend/*`, asserted by
  `test/same-site.test.ts`.
- **Vercel does not forward WebSocket upgrades**, so the event stream still connects to
  `wss://nap-api.onrender.com/ws`, where the cookie is not sent. The page first asks for a
  **stream ticket** over the proxy and carries it in the socket's query string —
  `apps/api/src/auth/stream-ticket.ts`.
- **Vercel waits 120 seconds for a first byte**, the same as the API's own request limit.
- GitHub's webhooks can stay on Render's host: they carry no cookie.

The variables, then: `NAP_API_URL=https://nap-tawny.vercel.app/backend` and
`NAP_WEB_ORIGIN=https://nap-tawny.vercel.app` on all three Render services;
`NEXT_PUBLIC_API_URL=https://nap-tawny.vercel.app/backend` and
`NEXT_PUBLIC_API_WS_URL=wss://nap-api.onrender.com` on Vercel. The OAuth callbacks are
`https://nap-tawny.vercel.app/backend/api/auth/callback/github` for sign-in, and
`https://nap-tawny.vercel.app/backend/github/callback` (setup: `…/backend/github/setup`) on the
GitHub App.

**With a domain of your own, the proxy is unnecessary**: `nap.<domain>` on Vercel and
`api.<domain>` on Render are one site, `NAP_API_URL=https://api.<domain>`, the WebSocket carries
the cookie itself, and the rewrite in `vercel.json` can go.

Check a deployment with `curl -si -X POST https://nap-tawny.vercel.app/backend/api/auth/sign-in/anonymous
-H "Origin: https://nap-tawny.vercel.app" | grep -i set-cookie`, which should say `SameSite=Lax`,
then sign in from Safari by every method — the social path has no in-app check, so a failure there
lands on `/sign-in?expired=1` rather than saying why.

**Never `Partitioned`.** On two sites it looks like the right companion to `SameSite=None`,
and it breaks OAuth completely. A partitioned cookie is keyed to the top-level site that was
open when it was set, so the `state` cookie written during the authorize POST is filed under
the *app's* site; the provider's callback is a top-level navigation to the *API's* site, a
different partition, where the browser does not send it. better-auth sees a state cookie that
never came back and refuses with `state_security_mismatch`, which arrives as
`…/?error=state_mismatch`. It was shipped that way once and found by trying to sign in with
GitHub.

## What a public URL costs

The demo door is open by default (`NAP_ALLOW_DEMO=true`): a visitor with no account gets a
throwaway identity and turns paid for by this deployment. The ceilings are the reason that
is affordable, and they are worth setting deliberately rather than inheriting:

- `NAP_FREE_TURNS_PER_HOUR=5`, `NAP_FREE_MAX_SANDBOXES_PER_USER=1` — per visitor.
- `NAP_MAX_SANDBOXES_TOTAL=10` — **everybody together, across every replica**. It is a count
  of rows in Postgres, reserved under a lock at the moment a sandbox is created, so it means
  the same number whether one process is running or six. This is the only one that bounds
  total spend; the per-user limits multiply by the number of users. Ten concurrent E2B
  sandboxes is ten times the burn rate of one.
- `NAP_REAP_IDLE_MINUTES=10` — how long an abandoned project keeps costing money. The same
  tick reconciles the ceiling, so a slot leaked by a crash comes back within minutes rather
  than waiting for a deploy.
- `NAP_WORKER_CONCURRENCY=25` — how many queued turns *one worker* runs at once. Not a
  ceiling on spend, which is what the three above are: turn it down when a pod is the
  bottleneck, not when the bill is. A turn that cannot be claimed waits in `turn_requests`
  rather than being refused, so this changes latency and never who gets in. The default is
  derived in `docs/scaling-baseline.md` and deliberately below what that run licenses.
- `NAP_CAPTURE_CONCURRENCY=1` — how many browsers a worker may have open at once. Every
  committed turn asks for a picture unless it was stopped or has a repair still to come, so
  this is *not* the worker's concurrency: unbounded it
  would be 25 simultaneous Chromiums in one container, and an OOM kill costs every turn in
  flight rather than a thumbnail. Pictures are taken after the session's lease goes back, so
  a slow browser delays a card and never a follow-up message. At most `NAP_WORKER_CONCURRENCY`
  projects wait for one. A project already waiting has its place taken over by its newer request;
  a new project's request past that cap is dropped. A shutdown drops the queue.
- `NAP_DRAIN_TIMEOUT_SECONDS=600` — how long a worker being taken away waits for the turns it
  is already running before aborting them. Keep it inside the platform's grace period.
- `NAP_WORKER_FALLBACK_POLL_SECONDS=5` — how often an idle worker that can hear claim wake-ups
  asks the queue anyway, which is the most a lost wake-up delays a turn. At most 30, because the
  claim loop coming round is also the worker's liveness heartbeat. A worker that cannot hear
  polls every 100 ms whatever this says.
- `NAP_REAP_INTERVAL_SECONDS=60` — how often the reaper looks. The idle sweep and the janitor
  tick separately, on purpose: an idle project can wait a minute to be put away and a chat pane
  waiting on a turn that will never finish cannot.
- `NAP_JANITOR_INTERVAL_SECONDS=15` — how often to look for turns whose worker died holding
  their lease. Not a ceiling on anything: it is how long somebody watching an interrupted turn
  waits to be told, on top of the lease and its grace window. The grace itself is a fence and is
  not configurable — shortening it is what would allow two writers on one session.

## Verifying a deployment

```bash
curl https://nap-api.onrender.com/health          # 200, every check "ok"
NAP_API_URL=https://nap-api.onrender.com bun run acceptance --keep
```

`apps/api/scripts/acceptance.ts` drives the six steps of `docs/PLAN.md` §6 over the same
HTTP and WebSocket surface a browser uses, and `--keep` prints a preview URL it has polled
for a 200 first. On Luna it costs a few cents.

`/health` answers **200 even when degraded**, on purpose: a non-2xx is how a platform
decides to restart or de-register a process, and neither helps when the thing that is down
is Postgres. Read the body, not the status.

That is the right answer for a human, and for a Railway service with nowhere else to send the
traffic. It is the wrong one for an orchestrator with other pods to hand it to, which is why two
other endpoints exist — the Kubernetes probes use them, and Railway's healthcheck stays on
`/health`:

| Endpoint | Answers | Meant for |
|---|---|---|
| `/livez` | 200, touching no dependency | a `livenessProbe` |
| `/readyz` | **503** when Postgres is unreachable, 200 otherwise | a `readinessProbe` |
| `/health` | 200 with a body naming each dependency, degraded or not | a person, and `curl` |

Why each answers what it does — and why readiness watches Postgres but not the sandbox
provider — is in `docs/GOTCHAS.md`, under API, auth and logging.

## Screenshots

The dashboard's cards are pictures of the apps themselves, taken at the end of the last turn
that changed each one. That needs a browser in the image, so `Dockerfile` installs Debian's
`chromium` and sets **`NAP_CHROME_PATH=/usr/bin/chromium` itself**. Do not set it as a Railway
variable: the binary and the path to it are one fact, and a variable can drift from the image
that has to satisfy it.

It costs about a gigabyte of image — chromium is ~370MB and drags in mesa and libllvm for a GPU
stack it never uses. Runtime memory only moves while a capture is in flight, which is a second or
two per turn, and `NAP_CAPTURE_CONCURRENCY` is what stops a worker running twenty-five of them at
once — but it is the reason this was off at first.

**A missing browser is not an error anywhere.** Capture returns a typed failure, the turn
succeeds regardless, the thumbnail route 404s and each card falls back to a colour hashed from
its project id. So the way to tell which state you are in is the boot line: `bun`'s log at
startup carries `screenshots: "on" | "off"`. If it says `off`, the image lost its Chromium —
nothing else will tell you, because every layer below is designed to shrug.

## The other deployment: Kubernetes

`infra/k8s/base/` is the same three processes as manifests — API pods behind a Service and an
Ingress, worker pods behind nothing, and one reaper — with `infra/k8s/README.md` as the map and
each file's own header as the reason it is shaped that way. It is where a deployment goes when one
Railway replica per process stops being enough; Railway remains what is live today.

Four things there are easy to get wrong, and every one of them fails without an error:

- **Probes go to `/livez` and `/readyz`, never `/health`.** `/health` answers 200 while degraded on
  purpose, so a probe on it never takes a broken pod out of the rotation.
- **The ingress must be more patient than the application.** The socket pings every 30s and gives
  up at 150. A proxy that expires first cuts healthy connections from the middle, silently — on a
  kind cluster a 10s timeout kills an idle socket in ten seconds. ingress-nginx's 60s default
  survives, but only on the back of that 30s ping: the margin is one missed ping, and the
  application's window is what should decide.
- **The worker's grace period must comfortably exceed `NAP_DRAIN_TIMEOUT_SECONDS`** — 900 around
  600 — or a rolling restart is a kill, and every turn in flight costs a human a reopen.
- **Migrations are a Job you run, never a pod's boot.** A dozen replicas racing one schema change
  is the reason nothing here migrates at startup.

Those four, and the reaper being singular, and no credential appearing in a manifest, are asserted
in `test/k8s.test.ts` rather than left to review — each one against a synthetic manifest that
breaks it, since a check nobody has watched fail is not known to work.

Three claims a file cannot make are checked by running it: `infra/k8s/proof/run.sh` brings up a kind
cluster at API 3 / workers 2 / reaper 1 and confirms that a turn submitted to one pod completes and
streams to a socket on another, that a cancel pressed on one pod stops a turn on a worker well inside
a renewal, and that a rolling restart of the API loses no events. The pods
there run `apps/api/scripts/cluster-proof.ts` — the same composition and the same Postgres fanout,
with a scripted model and an in-memory sandbox — so the run costs nothing and proves nothing about
E2B or OpenRouter, which is what `bun run acceptance` is for.

`infra/k8s/load/run.sh` is the same cluster with both autoscalers live and the k6 ramp against it;
what that run measured, and which of the design's invariants it did and did not demonstrate, is
`docs/scaling-cluster.md`. **Quote a scaled figure from there and nowhere else.**

## Things that are not deployed, deliberately

- **The integration suite.** It spends real money and stays a manual, local step.

## GitHub repository connections

Register a separate GitHub App and configure all six `NAP_GITHUB_*` variables on the API,
workers and reaper. On Railway they are `preserve()` in `.railway/railway.ts`, so they are set on the
services like the other credentials; on Kubernetes they go in `nap-secrets`, where
`infra/k8s/base/secret.example.yaml` lists them commented out. Apply migrations 0009 and 0010 before
starting the updated processes. The container includes Git for the server broker. Run the reaper for
signed webhook processing and the PR refresh that catches missed deliveries. The exact URLs, permissions, setup steps and rollout limits are in
[GitHub integration](github-integration.md). The existing `GITHUB_CLIENT_*` sign-in app and
model-provider credentials have separate purposes.

## Computer capability rollout

The boot composition supplies the scoped exec desktop and recording adapter, the durable Postgres input reservation store, coordinator, and already-required auth secret. Migration 0016 must be applied before enabling these workers or owner input. New claims exclude every reserved project. The reaper runs bounded input recovery separately from idle teardown. VNC remains view-only; owner input uses the authenticated API and is excluded while any project session has a lease. Stream credentials never enter events. Deploy strict event readers and owner media routes before producing `test.recording` events.

The desktop image is a separate manual publication. Prepare and review it with `bun run --cwd packages/sandbox template:build --prepare`; publishing requires explicit paid mode, the target alias, the prepared directory and its reviewed manifest hash. Publication refuses a prepared image whose build is not the checkout's `DESKTOP_BUILD`, and prints the build it published. Preparation selects two vCPUs and `DESKTOP_MEMORY_MB` (2,048 MB), and publication refuses a prepared directory of any other size. An integrated run with a real app peaked at 915 of 976 MiB on the earlier 1-GiB machine ([computer use](computer-use.md#verified-on-a-vm)), which is why it doubled; no run establishes capacity for larger applications.

Existing VMs do not receive a rebuilt template. A project with no held computer reservation can close and reopen through the ordinary snapshot/restore flow to get a fresh machine. A held reservation blocks that flow; use the rollout below before replacing its matching runtime. Do not destroy an active workspace to install the desktop. Recording media survives VM teardown in object storage, behind owner authorization, and project deletion derives its possible keys from durable test starts.

### Deploy a desktop build change

The build check covers every driver command, including `closeAndDrain`. A new runtime cannot
obtain a drain proof from an old-image scope. Preserve the old matching reaper until every held
scope has drained; otherwise those reservations remain recovery pending and exclude project
turns and closure even after the template is republished.

Before any `DESKTOP_BUILD`-changing merge or release, including introduction of this gate:

1. Block owner-input requests at ingress and let in-flight owner-input requests settle. Stop and
   drain all old workers, and wait for their exit so neither owner nor model input can create
   another reservation. Keep the old reaper, whose runtime matches the existing images, running.
2. Allow that reaper to recover outstanding scopes. Query the production database:
   ```sql
   SELECT count(*) FROM project_computer_operations;
   ```
   Proceed only when the result is `0`. If any row remains, stop the release and investigate
   with the matching reaper still available. Never delete a reservation or force abandonment
   to pass this gate; abandonment can discard source after the last snapshot.
3. Prepare, review and publish the template from the release commit as described above. Only
   after the reservation count is zero may the matching old reaper be stopped or replaced.
4. Merge or release the new commit with owner input still blocked. Deploy required migrations,
   workers, API and reaper in the release order above, then the web. Reopen owner input only
   after the matching services are live. Ordinary stale projects without a held reservation
   can then close and reopen to use the new image.

This is an operator precondition; the automatic release does not enforce the SQL check.

### Deploy the scoped input protocol together

Prevent mixed old/new claim code while enabling scoped input. Block owner input at ingress, stop and drain all old workers, and wait for their exit. Deploy the migration and matching API, reaper, and worker code before reopening owner input. Pending queue requests may wait. Do not clear a reservation to expedite rollout, or delete one by hand: when a machine is gone for good, its owner abandons it from the chat, which also forgets the machine so it is never given input again, and loses anything not in the project's last snapshot. Before a machine's first reservation, input asks its driver which protocol it speaks. A VM created before scoped input could never drain a reservation, so it gets no reservation and no input, and the project otherwise keeps working; close and reopen it to get a machine with the new driver. Existing VMs do not receive a new driver by publishing a template.

The desktop runtime uses Python 3 and libX11/libXtst for fixed full-keyboard and button release and state queries. These are explicit template dependencies. Verify the real installed input binary retains the inherited descriptor with the L2 production-driver probe before claiming the mechanism works. Cooperative fixed input programs, not arbitrary processes, are the containment boundary. Local time budgets do not expire admission reservations.

## Plan mode rollout

Plan mode adds the `turn_requests.plan` column (migration 0017), one event type (`plan.proposed`)
and two optional payload fields (`user.message.plan`, `turn.completed.awaiting`). Every reader parses
events strictly, so an old process or an open old browser tab rejects the new shapes. Old rows still
parse, because both fields are optional.

The danger runs the other way too. An old worker claims a queued request without reading the
`plan` column, so it would run a plan mode request as an ordinary turn with every tool, and an
approval as a build with no plan in its prompt. Once the new API is up, anything can send a plan
intent, so no old worker may still be claiming by then.

For Render, configure the worker migration command before merging, as described in the release
procedure above. CI then enforces migration and worker replacement before API admission. Its
preflight refuses a missing or different migration command before any deploy. For a manual or
non-Render rollout:

1. Apply migration 0017. The column is nullable, so the old API and old workers carry on.
2. Stop and drain every old worker as in the repair ownership rollout above, then deploy the new
   workers. They write the new shapes only when handed a plan intent, and the old API cannot admit
   one, so the old API and reaper never meet those shapes.
3. Deploy the API and the reaper.
4. Deploy the web.

See [ADR-0025](adr/0025-plan-mode-proposes-and-the-next-message-decides.md).

## Steering rollout

Steering adds the `turn_steers` table and `turn_requests.steering_closed` (migration 0019), three event
types (`steer.received`, `steer.applied`, `steer.dropped`) and one route (`POST
/sessions/:id/steers`). Unlike plan mode, **the API writes one of the new events**: it records
`steer.received` the moment it admits a steer, so the new shapes appear in a log as soon as a new
API takes a steer, not only once a new worker runs.

Every reader parses events strictly, so the order is the same as plan mode's, for the same reasons,
plus one. An old worker runs a request without reading or closing its steers. That request settles
normally, so nothing ever answers for the steers joined to it. The pane offers each back as not
sent once the session is idle. So no old worker may be claiming once a new API admits steers.

1. Apply migration 0019. The table is new and the column defaults to false, so the old API and old
   workers carry on.
2. Stop and drain every old worker, then deploy the new workers.
3. Deploy the reaper, then the API. The reaper's janitor reads whole session logs. An old one that
   meets `steer.received` while closing out a request fails that request's announcement and retries
   it on its next tick. On Render the release deploys the API first, so expect that for at most one
   reaper deploy. Retries are idempotent, so the failure costs a delay, not a terminal event.
4. Deploy the web. Only the new web sends a steer. An old tab cannot parse the new events, and
   reloading it fixes that.

Rolling back is not the reverse. Once any `steer.*` event is in a session's log, an API, worker or
reaper from before this change rejects that whole session, as it would any shape it cannot parse, so
a prior image is not a safe rollback once a new API has admitted a steer. Stop the steering producers
and roll forward with compatible readers instead, as with any new event metadata above.

The Render release script already deploys in this order, apart from step 3's swap, and the worker's
pre-deploy command applies 0019 before new workers boot. See
[ADR-0028](adr/0028-a-steer-joins-the-turn-and-the-row-decides-where-it-lands.md).

## App test goal rollout

Migration `0020_turn_request_fixes_test.sql` adds nullable `turn_requests.fixes_test`.
Workers carry that marker into the runtime, which writes optional `user.message.fixesTest` and
`job.started.goal` fields. Old strict event readers reject those fields. Old workers ignore the
queue marker and would judge the next test against the repair prompt again.

For a manual rollout:

1. Apply migration 0020. Its nullable column leaves old requests readable.
2. Stop and drain every old worker, then deploy the new workers.
3. Deploy the reaper and API before accepting requests with `fixesTest`.
4. Deploy the web after every backend reader is compatible. Reload existing browser tabs.
   Old tabs neither send the marker nor understand the new event fields. They can omit repair
   prompts and job cards until reloaded.

The Render release already applies migrations and replaces workers before API admission, then
replaces the reaper before publishing the web. Its API/reaper order differs from step 3. Keep
requests carrying `fixesTest` paused until both deployments finish if clients other than the web
can send them. Publishing the new web does not refresh tabs already open.

Once either new field is durable, do not roll an event reader back to a version that rejects it.
Stop new repair submissions and roll forward with compatible readers. Old logs remain readable,
but already-contaminated test goals are not backfilled or recovered from prompt text. See
[Fix it](computer-use.md#fix-it) for the structured repair path.
