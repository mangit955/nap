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
  turn still running 270 seconds into a deploy is aborted rather than killed mid-write.
- **Migrations run as the API's pre-deploy command**, once per release and before the new API
  takes traffic, not at boot. A release that adds tables still needs the API deployed before the
  worker and the reaper, which would otherwise start against a schema that is not there yet.
- **One database URL serves both connections.** Render Postgres has no pooler in front of it, so
  `DATABASE_URL` and `NAP_LISTEN_DATABASE_URL` are the same internal connection string, and the
  database accepts no connections from outside Render.
- **The worker is the 2 GB plan.** It runs Chromium for the preview screenshots; the Kubernetes
  manifests request 1 GiB for the same process, and 512 MB is where it runs out.
- **GitHub Actions releases production after CI passes on `main`.** Render's own auto-deploys
  stay off. The `production` job deploys the API, reaper and worker in that order, then Vercel,
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
Render services have auto-deploy disabled before changing anything. It waits for the API to
be live and `/readyz` to report `ok`, then waits for the reaper and worker before starting
Vercel. It verifies each deployed commit and waits for Vercel to reach `READY`. Each deployment
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
| **The in-memory registry** — `TurnRegistry` meant a cancel landing on pod A could not reach a turn on pod B, and `isBusy` went blind | Cancellation is a row. `cancel_requested` on `turn_requests` reaches an executing turn on any pod within one lease renewal (≤15s); the registry survives only as the same-process fast path. **Busy** is `TurnQueue.anyLeased` — a `state = 'leased'` query — so close, delete and the idle sweep all get the same answer cluster-wide |
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

`NAP_EVENT_BUS=postgres` swaps `InProcessEventBus` for `PostgresNotifyEventBus`. Two things to get
right when you do:

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

The two origins refer to each other, so the first deployment is circular: deploy the API,
take its domain to Vercel, then come back and set `NAP_WEB_ORIGIN` and redeploy.

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
NEXT_PUBLIC_API_URL     https://<the railway domain>
NEXT_PUBLIC_API_WS_URL  wss://<the railway domain>
```

`wss://`, not `ws://`: a page served over https may not open an insecure socket.

### 4. OAuth callbacks

better-auth builds redirect URIs from `NAP_API_URL`, so each provider's app needs
`https://<railway domain>/api/auth/callback/github` (and `/google`).

## The session cookie, and the browsers where sign-in will not work

The app and the API are on two different sites (`vercel.app` and `railway.app`), which
makes the session cookie third-party. `apps/api/src/auth/cross-site.ts` detects that from
the two URLs and switches the cookie to `SameSite=None; Secure`, without which the browser
would keep the cookie and never send it back — sign-in answering 200 and everything after
it answering 401.

**Not `Partitioned`, and that is not an oversight.** It looks like the right companion to
`SameSite=None` and it breaks OAuth completely. A partitioned cookie is keyed to the
top-level site that was open when it was set, so the `state` cookie written during the
authorize POST is filed under the *app's* site; the provider's callback is a top-level
navigation to the *API's* site, a different partition, where the browser does not send it.
better-auth sees a state cookie that never came back and refuses with
`state_security_mismatch`, which arrives as `…/?error=state_mismatch`. It was shipped that
way once and found by trying to sign in with GitHub.

**Safari and Brave block third-party cookies outright, so sign-in does not work there.**
Chrome and Firefox are fine. This is a known, accepted limitation of running the two halves
on free subdomains, and the fix is to stop being cross-site: put both behind one registrable
domain (`nap.example.com` and `api.example.com`), at which point `isCrossSite` returns
`false` on its own and the cookie goes back to `SameSite=Lax` with no code change: it
compares registrable domains rather than hosts, and `cross-site.ts` says how far that
comparison is trusted. DNS on both dashboards, update the four URL variables, redeploy.

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
  committed turn is photographed, so this is *not* the worker's concurrency: unbounded it
  would be 25 simultaneous Chromiums in one container, and an OOM kill costs every turn in
  flight rather than a thumbnail. Nobody waits on a card, so queueing costs nothing visible.
- `NAP_DRAIN_TIMEOUT_SECONDS=600` — how long a worker being taken away waits for the turns it
  is already running before aborting them. Keep it inside the platform's grace period.
- `NAP_REAP_INTERVAL_SECONDS=60` — how often the reaper looks. The idle sweep and the janitor
  tick separately, on purpose: an idle project can wait a minute to be put away and a chat pane
  waiting on a turn that will never finish cannot.
- `NAP_JANITOR_INTERVAL_SECONDS=15` — how often to look for turns whose worker died holding
  their lease. Not a ceiling on anything: it is how long somebody watching an interrupted turn
  waits to be told, on top of the lease and its grace window. The grace itself is a fence and is
  not configurable — shortening it is what would allow two writers on one session.

## Verifying a deployment

```bash
curl https://<railway domain>/health          # 200, every check "ok"
NAP_API_URL=https://<railway domain> bun run acceptance --keep
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

Two claims a file cannot make are checked by running it: `infra/k8s/proof/run.sh` brings up a kind
cluster at API 3 / workers 2 / reaper 1 and confirms that a turn submitted to one pod completes and
streams to a socket on another, and that a rolling restart of the API loses no events. The pods
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

The desktop image is a separate manual publication. Prepare and review it with `bun run --cwd packages/sandbox template:build --prepare`; publishing requires explicit paid mode, the target alias, the prepared directory and its reviewed manifest hash. Preparation selects two vCPUs and 1,024 MB. The cloud spike measured a minimal Chrome/Vite fixture at that size; it did not establish capacity for larger applications. Production publication and integrated cloud validation remain pending approval.

Existing VMs do not receive a rebuilt template. Close and reopen a project through the ordinary snapshot/restore flow when a fresh machine is needed; do not destroy an active workspace to install the desktop. Recording media survives VM teardown in object storage, behind owner authorization, and project deletion derives its possible keys from durable test starts.


### Deploy the scoped input protocol together

Prevent mixed old/new claim code while enabling scoped input. Block owner input at ingress, stop and drain all old workers, and wait for their exit. Deploy the migration and matching API, reaper, and worker code before reopening owner input. Pending queue requests may wait. Do not clear a reservation to expedite rollout, or delete one by hand: when a machine is gone for good, its owner abandons it from the chat, which also forgets the machine so it is never given input again, and loses anything not in the project's last snapshot. Before a machine's first reservation, input asks its driver which protocol it speaks. A VM created before scoped input could never drain a reservation, so it gets no reservation and no input, and the project otherwise keeps working; close and reopen it to get a machine with the new driver. Existing VMs do not receive a new driver by publishing a template. Production publication and integrated cloud validation remain separate approval gates.

The desktop runtime uses Python 3 and libX11/libXtst for fixed full-keyboard and button release and state queries. These are explicit template dependencies. Verify the real installed input binary retains the inherited descriptor with the L2 production-driver probe before claiming the mechanism works. Cooperative fixed input programs, not arbitrary processes, are the containment boundary. Local time budgets do not expire admission reservations.
