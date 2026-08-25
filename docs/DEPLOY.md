# Deploying Nap

**Live:** the app is at <https://nap-tawny.vercel.app> and the API at
<https://nap-api-production.up.railway.app>.

Two services and four accounts. The web app is on Vercel, the API on Railway, and the
API is the one that holds all the state and spends all the money.

| Piece | Where | Notes |
|---|---|---|
| `apps/web` | Vercel | Next 16, root directory `apps/web` |
| `apps/api` | Railway | This repo's `Dockerfile`, **one replica as deployed, which is a choice and no longer a rule** — see below |
| `apps/api`'s worker | Railway | The *same image*, started as `bun apps/api/src/worker.ts`. Also one as deployed, also scalable |
| `apps/api`'s reaper | Railway | The same image again, `bun apps/api/src/reaper.ts`, **exactly one replica** |
| Postgres | Neon | A database of its own, not the development one |
| Object storage | Cloudflare R2 | Snapshots of projects nobody is using |
| Sandboxes | E2B | Created per project, billed by the second |
| Model | OpenRouter | `openai/gpt-5.6-luna` by default |

## Three entrypoints, one image

The binary is split (`docs/scaling-design.md` §4 and §13). One image, three commands:

| | Command | Serves | Executes | Replicas |
|---|---|---|---|---|
| API | `bun apps/api/src/index.ts` (the Dockerfile's default) | HTTP, WebSockets, auth, admission | nothing | as many as you like; one on Railway today |
| Worker | `bun apps/api/src/worker.ts` | nothing | turns | as many as you like; one on Railway today |
| Reaper | `bun apps/api/src/reaper.ts` | nothing | the idle sweep, capacity reconciliation, the rate-event sweep, the janitor | **exactly one** |

All three call `bootNap` in `apps/api/src/boot.ts` and differ only by the role they pass, so
there is one composition rather than three that drift. A turn reaches a worker through
`turn_requests` and nothing else; there is no call between any of the processes.

**Deploying this needs a Railway service each, and the API stops running turns without the
worker.** Same repo, same Dockerfile, same variables — what differs is the start command, and
**the healthcheck path must be empty for the two that serve nothing**, because whether a worker
is working is a question about queue depth.

**That last point needs a config file per role, and finding out why cost a broken deployment.**
Railway applies `railway.json` as config-as-code on every deploy *from that repo*, so a single
file at the root governs all three services and re-imposes its `healthcheckPath` no matter what
the service is set to in the dashboard or through the API. A worker inherits `/health`, serves
nothing, never answers, and the deployment fails at the `HEALTHCHECK` step — **after** the
process has booted correctly and logged `worker claiming`, which is what makes it confusing:
the logs show a working worker and the deploy shows a failure. So there are three files, and
each service points at its own through the *Config-as-code* setting (`railwayConfigFile`):

| Service | Config file | Start command | Healthcheck |
|---|---|---|---|
| `nap-api` | `railway.json` | the Dockerfile's default | `/health` |
| `nap-worker` | `railway.worker.json` | `bun apps/api/src/worker.ts` | none |
| `nap-reaper` | `railway.reaper.json` | `bun apps/api/src/reaper.ts` | none |

Setting the start command on the service without pointing it at the right config file half-works
— the command applies, the healthcheck still kills it — which is the failure this table exists to
stop somebody rediscovering.

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
`railway.json` pins `numReplicas: 1`, and `NAP_EVENT_BUS` still defaults to `in-process` — so
scaling *this* deployment is two edits, not one. **Raising the replica count without setting the
event bus is exactly the failure the old rule described**, and nothing will tell you: the turns run
and the chat panes stop moving. The multi-pod shape lives in `infra/k8s/`, where both are set in the
manifests.

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

An API pod is cheaper: stop accepting, close each socket with a normal close code, exit. Clients
reconnect with `?afterSeq=` and lose nothing, because the log is the delivery.

A worker that dies *without* a `SIGTERM` is the janitor's: past the lease's grace window it marks
the request `orphaned` and writes the terminal event the interrupted turn never got, so the chat
pane is told rather than spinning. It never requeues — nothing re-executes with nobody watching.

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

`railway.json` already selects the Dockerfile, pins one replica and points the healthcheck
at `/health`. Set the variables below; Railway injects `PORT` itself.

```
DATABASE_URL              the Neon URL from step 1
E2B_API_KEY
OPENROUTER_API_KEY
BETTER_AUTH_SECRET        openssl rand -base64 32 — a fresh one, not the dev value
NAP_KEY_ENCRYPTION_SECRET openssl rand -base64 32 — must decode to exactly 32 bytes
R2_ACCOUNT_ID R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
NODE_ENV=production
NAP_API_URL               https://<the railway domain>
NAP_WEB_ORIGIN            https://<the vercel domain>
```

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
