# Deploying Nap

Two services and four accounts. The web app is on Vercel, the API on Railway, and the
API is the one that holds all the state, spends all the money, and must not be scaled.

| Piece | Where | Notes |
|---|---|---|
| `apps/web` | Vercel | Next 16, root directory `apps/web` |
| `apps/api` | Railway | This repo's `Dockerfile`, **one replica** |
| Postgres | Neon | A database of its own, not the development one |
| Object storage | Cloudflare R2 | Snapshots of projects nobody is using |
| Sandboxes | E2B | Created per project, billed by the second |
| Model | OpenRouter | `openai/gpt-5.6-luna` by default |

## The rule that matters most: one replica

**Never scale the API past one instance.** It is not stateless and is not meant to be:

- `InProcessEventBus` (`packages/db/src/in-process-event-bus.ts`) fans out events to
  WebSocket subscribers *inside one process*. A browser connected to instance A would never
  see a turn that ran on B — the chat would simply stop moving.
- `TurnRegistry` (cancellation, and the per-session queue that stops one project starting
  two sandboxes) is in memory.
- `TurnRateLimiter` is in memory, so N instances mean N times the rate limit.
- The reaper runs in-process. It is what snapshots an idle project and destroys its
  sandbox, and it is the only thing standing between an abandoned tab and an E2B bill.

That last point also rules out anything that sleeps an idle service: a sleeping process is
a reaper that is not reaping while the sandboxes it should have cleaned up keep billing.
`railway.json` pins `numReplicas: 1`; leave app sleeping off.

The event log itself is durable and ordered in Postgres, so a *restart* loses nothing — a
client reconnects with `?afterSeq=` and gets exactly the gap. It is concurrency that breaks
this, not restarts.

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
- **An empty variable is not an unset one.** `NAP_CHROME_PATH=` fails boot with
  *"expected string to have >=1 characters"*. Leave optional variables out entirely.

The two origins refer to each other, so the first deployment is circular: deploy the API,
take its domain to Vercel, then come back and set `NAP_WEB_ORIGIN` and redeploy.

### 3. The web app on Vercel

Root directory `apps/web`; install `bun install`, build `bun run build`. Two variables,
both inlined at build time — changing either needs a redeploy, not just a restart:

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
the two URLs and switches the cookie to `SameSite=None; Secure; Partitioned`, without
which the browser would keep the cookie and never send it back — sign-in answering 200 and
everything after it answering 401.

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
- `NAP_MAX_SANDBOXES_TOTAL=10` — **everybody together**. This is the only one that bounds
  total spend; the per-user limits multiply by the number of users. Ten concurrent E2B
  sandboxes is ten times the burn rate of one.
- `NAP_REAP_IDLE_MINUTES=10` — how long an abandoned project keeps costing money.

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

## Things that are not deployed, deliberately

- **Screenshots.** `NAP_CHROME_PATH` is unset, so the dashboard's cards show a colour
  hashed from the project id instead of a picture. Turning it on means installing Chromium
  in the image and roughly doubling its memory ceiling.
- **The integration suite.** It spends real money and stays a manual, local step.
