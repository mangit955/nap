/**
 * The Railway deployment: three services, one image, one source of truth.
 *
 * This replaces `railway.json`, `railway.worker.json` and `railway.reaper.json`. Those worked by
 * pointing each service at its own file through Railway's *Config-as-code* setting, and that
 * setting no longer exists — the API now rejects it outright with "Config as Code (railway.json /
 * railway.toml) is deprecated". A service created from this repo under the old scheme silently
 * builds with Railpack, ignores the Dockerfile, and inherits no start command, so the worker and
 * the reaper both come up as a second copy of the API.
 *
 * The three roles differ in exactly two ways, and both are below: which entrypoint they start, and
 * whether they answer a healthcheck. Everything else is deliberately identical, because the image
 * is. See `docs/DEPLOY.md` for what each process owns.
 *
 * Credentials are `preserve()` — the value stays whatever is set on the service, and no secret is
 * ever written here. This file is committed; the variables are not.
 */
import { defineRailway, github, preserve, project, service } from "railway/iac";

/** Every service builds the same image from the same commit. */
const source = github("mangit955/nap");

const build = {
  buildEnvironment: "V3",
  builder: "DOCKERFILE",
  dockerfilePath: "Dockerfile",
} as const;

/**
 * All three services carry the same variables, because all three are the same composition with a
 * different role passed to `bootNap`.
 *
 * The settings named here are the ones a reader would otherwise have to discover from a dashboard.
 * `NAP_EVENT_BUS` is the one that must be true before anything else is: a worker publishing to an
 * in-process bus announces a turn to nobody, since every socket watching it is on the API service.
 * Turns would run perfectly while every chat pane sat still — so the worker and the reaper refuse
 * to boot without it rather than letting that be found from a browser.
 *
 * Everything else is `preserve()`: the value is whatever is set on the service and nothing
 * overwrites it from here, which is how a credential stays out of a committed file. Two are absent
 * on purpose. `NAP_CHROME_PATH` is set by the image, because the browser and the path to it are
 * one fact and a platform variable can only drift from it. The Google OAuth pair is unset rather
 * than blank — an empty variable is not an unset one, and half a pair fails boot.
 */
const napEnv = {
  NAP_EVENT_BUS: "postgres",
  NODE_ENV: "production",
  NAP_API_URL: "https://nap-api-production-731a.up.railway.app",
  NAP_WEB_ORIGIN: "https://nap-tawny.vercel.app",
  DATABASE_URL: preserve(),
  NAP_LISTEN_DATABASE_URL: preserve(),
  BETTER_AUTH_SECRET: preserve(),
  NAP_KEY_ENCRYPTION_SECRET: preserve(),
  E2B_API_KEY: preserve(),
  OPENROUTER_API_KEY: preserve(),
  GITHUB_CLIENT_ID: preserve(),
  GITHUB_CLIENT_SECRET: preserve(),
  R2_ACCOUNT_ID: preserve(),
  R2_BUCKET: preserve(),
  R2_ACCESS_KEY_ID: preserve(),
  R2_SECRET_ACCESS_KEY: preserve(),
};

/**
 * A turn is minutes of model and sandbox latency, and Railway's default grace period is **zero
 * seconds** — SIGTERM is followed immediately by SIGKILL. Without this the worker's own drain
 * (`NAP_DRAIN_TIMEOUT_SECONDS`, 600 by default) never gets to run: it stops claiming, keeps
 * renewing its leases, and is killed mid-sentence anyway, so every turn in flight during a deploy
 * costs somebody a reopen. The number has to comfortably exceed that timeout for the same reason
 * `terminationGracePeriodSeconds: 900` sits around it in `infra/k8s/base`.
 */
const WORKER_DRAINING_SECONDS = 900;

/**
 * An API pod's shutdown is cheap — stop accepting, close each socket with a normal close code, and
 * let clients reconnect with `?afterSeq=`, which loses nothing because the event log is the
 * delivery. It still wants more than zero, or those sockets are severed rather than closed.
 */
const SERVER_DRAINING_SECONDS = 60;

/**
 * `sleepApplication` is off everywhere, and on the reaper that is not a preference: a sleeping
 * reaper is not reaping, while the sandboxes it should have torn down keep billing by the second.
 */
const deploy = {
  restartPolicyType: "ON_FAILURE",
  restartPolicyMaxRetries: 10,
  sleepApplication: false,
} as const;

export default defineRailway(() => {
  const napApi = service("nap-api", {
    source,
    build,
    healthcheck: "/health",
    healthcheckTimeout: 30,
    replicas: { sfo: 1 },
    // Railway injects `PORT` and it is 8080, not the 3001 this app defaults to locally. A domain
    // pointed at the wrong port answers 502 while the container logs a perfectly healthy boot,
    // which is a confusing hour if the port is left implicit.
    //
    // `serviceDomains`, not the `domains` shorthand: that shorthand means *custom* domains, which
    // are the ones needing DNS verification. This is a Railway-provided subdomain, and declaring
    // it in the wrong bucket asks the platform to verify a domain it already owns.
    networking: {
      serviceDomains: { "nap-api-production-731a.up.railway.app": { port: 8080 } },
    },
    deploy: { ...deploy, drainingSeconds: SERVER_DRAINING_SECONDS },
    env: napEnv,
  });

  const napWorker = service("nap-worker", {
    source,
    build,
    start: "bun apps/api/src/worker.ts",
    replicas: { sfo: 1 },
    // No healthcheck, and its absence is load-bearing. A worker serves nothing, so it can never
    // answer one; inheriting `/health` means the deployment fails at the healthcheck step *after*
    // the process has booted correctly and logged `worker claiming`. The logs show a working
    // worker and the deploy shows a failure, which is what made this expensive to diagnose.
    deploy: { ...deploy, drainingSeconds: WORKER_DRAINING_SECONDS },
    env: napEnv,
  });

  const napReaper = service("nap-reaper", {
    source,
    build,
    start: "bun apps/api/src/reaper.ts",
    // Exactly one, permanently. It is the only thing that snapshots an idle project and destroys
    // its sandbox, and it reconciles the sandbox ceiling; two of them would do all of that twice,
    // the second teardown landing on a sandbox that is already gone. The process also takes a
    // `pg_try_advisory_lock` and skips any tick it does not hold, because a rolling update runs
    // two for a few seconds whatever this number says.
    replicas: { sfo: 1 },
    deploy: { ...deploy, drainingSeconds: SERVER_DRAINING_SECONDS },
    env: napEnv,
  });

  return project("nap", { resources: [napApi, napWorker, napReaper] });
});
