/**
 * The worker process: it claims turn requests, runs them, and serves nothing.
 *
 * The mirror image of `index.ts`, composed from the same `bootNap` with a different role. There is
 * no `fetch` export and no `Bun.serve`: nothing can reach this process from outside, and the only
 * thing it shares with the API is the queue. `docs/scaling-design.md` §4.
 *
 * **What keeps it alive is the claiming loop**, not a listening socket. The worker polls, the
 * reaper and the janitor tick, and each of those is a timer the runtime will not exit under. A
 * process whose loops had all been stopped would exit on its own, which is the right behaviour: a
 * drained worker has nothing left to do.
 *
 * Shutdown is `boot.ts`'s, and it is the interesting half of this file even though none of it is
 * written here. On `SIGTERM` the loop stops claiming, the turns already running are waited for —
 * with their leases renewed throughout, or the janitor would orphan work that is still
 * progressing — and anything still going at `NAP_DRAIN_TIMEOUT_SECONDS` is aborted, which commits
 * nothing and closes its job `abandoned`. Every request is settled on the way out either way, so a
 * rolling restart never leaves a chat pane waiting on an event nobody will write.
 *
 * Runs under Bun, as `bun run src/worker.ts`. See docs/DEPLOY.md for running it beside the API.
 */

import { bootNap } from "./boot.ts";
import { announce } from "./boot-line.ts";

const nap = await bootNap("worker");

announce(nap, "worker claiming", {
  concurrency: nap.env.NAP_WORKER_CONCURRENCY,
  drainTimeoutSeconds: nap.env.NAP_DRAIN_TIMEOUT_SECONDS,
  // Not the worker's concurrency, and the gap between the two is the point: every committed turn
  // is photographed, and this is how many browsers may be open at once while it happens.
  captureConcurrency: nap.env.NAP_CAPTURE_CONCURRENCY,
  screenshots: nap.env.NAP_CHROME_PATH === undefined ? "off" : "on",
  reapIdleMinutes: nap.env.NAP_REAP_IDLE_MINUTES,
  sandboxTtlMinutes: nap.env.NAP_SANDBOX_TTL_MINUTES,
  maxSandboxesTotal: nap.env.NAP_MAX_SANDBOXES_TOTAL,
});
