# Deploying Nap

**Live:** the app is at <https://nap-tawny.vercel.app> and the API at
<https://nap-api-production.up.railway.app>.

Two services and four accounts. The web app is on Vercel, the API on Railway, and the
API is the one that holds all the state and spends all the money.

| Piece | Where | Notes |
|---|---|---|
| `apps/web` | Vercel | Next 16, root directory `apps/web` |
| `apps/api` | Railway | This repo's `Dockerfile`, **one replica as deployed** — see below |
| `apps/api`'s worker | Railway | The *same image*, started as `bun apps/api/src/worker.ts` |
| `apps/api`'s reaper | Railway | The same image again, `bun apps/api/src/reaper.ts`, **exactly one replica** |
| Postgres | Neon | A database of its own, not the development one |
| Object storage | Cloudflare R2 | Snapshots of projects nobody is using |
| Sandboxes | E2B | Created per project, billed by the second |
| Model | OpenRouter | `openai/gpt-5.6-luna` by default |

## Three entrypoints, one image

The binary is split (`docs/scaling-design.md` §4 and §13). One image, three commands:

| | Command | Serves | Executes | Replicas |
|---|---|---|---|---|
| API | `bun apps/api/src/index.ts` (the Dockerfile's default) | HTTP, WebSockets, auth, admission | nothing | one here; see the replica rule below |
| Worker | `bun apps/api/src/worker.ts` | nothing | turns | one here; see the replica rule below |
| Reaper | `bun apps/api/src/reaper.ts` | nothing | the idle sweep, capacity reconciliation, the rate-event sweep, the janitor | **exactly one** |

All three call `bootNap` in `apps/api/src/boot.ts` and differ only by the role they pass, so
there is one composition rather than three that drift. A turn reaches a worker through
`turn_requests` and nothing else; there is no call between any of the processes.

**Deploying this needs a Railway service each, and the API stops running turns without the
worker.** Same repo, same Dockerfile, same variables — set the start command and leave the
healthcheck path empty for the two that serve nothing, because whether a worker is working is
a question about queue depth. One thing must be true first:

- **`NAP_EVENT_BUS=postgres`.** A worker publishing to an in-process bus announces a turn to
  nobody: every socket watching it is on the API pod. Turns would run perfectly while every
  chat pane sat still, so **the worker and the reaper both refuse to boot without it** rather
  than letting that be discovered from the browser — the reaper publishes too, when it stops a
  preview or closes out an interrupted turn. See below for the `LISTEN` pooler caveat.

**The reaper is one replica and says so twice.** Set `numReplicas: 1` *and* leave it alone: a
second one would snapshot and destroy the same project at the same moment, the second teardown
landing on a sandbox that is already gone. A rolling update runs two for a few seconds whatever
the replica count says, so the process also takes a `pg_try_advisory_lock` on a connection of
its own and skips any tick it does not hold. That lock is session state, so behind a pooler it
needs `NAP_LISTEN_DATABASE_URL` for the same reason `LISTEN` does.

Locally, `bun run dev`, `bun run dev:worker` and `bun run dev:reaper` are the three, against one
database and one `apps/api/.env`.

## The rule that matters most: one replica

**Do not scale the API past one instance while `NAP_EVENT_BUS` is `in-process`**, which is
the default and what is deployed:

- `InProcessEventBus` (`packages/db/src/in-process-event-bus.ts`) fans out events to
  WebSocket subscribers *inside one process*. A browser connected to instance A would never
  see a turn that ran on B — the chat would simply stop moving. **This one has a fix, and
  it is off by default** — see below.
- `TurnRegistry` is in memory and lives in the worker. It is now only a *fast path* for
  cancelling a turn that happens to be running in the process the request landed on;
  cancellation itself is a row, and reaches a turn on any pod within one lease renewal. Nothing
  else reads it: "is this session busy?", which close, delete and the idle sweep ask, is a
  `state = 'leased'` query against `turn_requests` and means the same thing everywhere.

**The reaper is the piece that must be exactly one**, whatever else scales. It is what
snapshots an idle project and destroys its sandbox — the only thing standing between an
abandoned tab and an E2B bill — and it also reconciles the sandbox ceiling, reclaiming slots
held by a process that died mid-creation and destroying sandboxes E2B is running that no
project references. Two of them would do all of that twice.

That also rules out anything that sleeps the *reaper*: a sleeping one is not reaping while the
sandboxes it should have cleaned up keep billing. `railway.json` pins `numReplicas: 1`; leave
app sleeping off on every service.

The event log itself is durable and ordered in Postgres, so a *restart* loses nothing — a
client reconnects with `?afterSeq=` and gets exactly the gap. It is concurrency that breaks
this, not restarts.

### The fanout half of it, and how to turn it on

`NAP_EVENT_BUS=postgres` swaps `InProcessEventBus` for `PostgresNotifyEventBus`, which
announces `{sessionId, seq}` through `pg_notify` and lets every process read the events out of
the durable log. That is the last of the per-process assumptions on the API and worker paths — the
sandbox ceiling is reserved in Postgres, the turn allowance is counted there, "busy" is a lease and
the sweeps live in a process of their own — so it is what a second API or worker replica waits on.
**Nothing here has run more than one, and this document is not the permission to**: that is #62's
call, made against a load run rather than a paragraph. `railway.json` pins `numReplicas: 1` on
every service, and the reaper's pin is the one that is permanent.

Two things to get right when you do turn it on:

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

## First deployment

### 1. A production database

Create a new Neon database or branch — do not point production at the development one,
which still holds pre-authorization rows that belong to nobody.

```bash
DATABASE_URL='<prod url>' bun run db:migrate
```

Migrations are deliberately not run at boot: one replica per process would race, and a
schema change is a decision rather than a side effect of a restart.

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
`false` on its own and the cookie goes back to `SameSite=Lax` with no code change. DNS on
both dashboards, update the four URL variables, redeploy.

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

That is the right answer for a human and for this one replica, and the wrong one for an
orchestrator with other pods to send traffic to. Two endpoints exist for that case, and
nothing polls them here — Railway's healthcheck stays on `/health`:

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
stack it never uses. Runtime memory only moves while a capture is in flight, which is a second
or two per turn on the one replica, but it is the reason this was off at first.

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

## Things that are not deployed, deliberately

- **The integration suite.** It spends real money and stays a manual, local step.
