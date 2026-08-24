/**
 * The reaper process: it tidies up after the other two, and neither serves nor executes.
 *
 * Four jobs, all of them "come past occasionally and put things right": put away the sandboxes of
 * projects nobody is looking at, give back capacity no path released, delete rate-limit rows that
 * have left their window, and close out turn requests whose worker never came back.
 *
 * **One replica, and that is the whole reason it is a process rather than a job the workers
 * share.** Every worker running the idle sweep would mean several of them snapshotting and
 * destroying the same project at once, the second one against a sandbox that is already gone.
 * `replicas: 1` is most of the answer and a rolling update is the rest of it, which is why boot
 * also gives this role — and only this role — a `pg_try_advisory_lock` on its own connection: the
 * old process and the new one overlap for a few seconds, and only one of them sweeps.
 *
 * It used to run beside the turns, and could not have run anywhere else: "is this project busy?"
 * was answered from an in-memory registry, so a sweep away from the turns read every busy project
 * as idle and would have torn one down mid-turn. That question is a lease in Postgres now, which is
 * what freed the sweep to live here.
 *
 * **What keeps it alive is the timers**, which is unlike either of the others — there is no socket
 * and no claiming loop — so its schedules are started referenced rather than unreferenced. See
 * `SweepSchedule`.
 *
 * Runs under Bun, as `bun run src/reaper.ts`. See docs/DEPLOY.md.
 */

import { bootNap } from "./boot.ts";
import { announce } from "./boot-line.ts";

const nap = await bootNap("reaper");

announce(nap, "reaper sweeping", {
  reapIntervalSeconds: nap.env.NAP_REAP_INTERVAL_SECONDS,
  reapIdleMinutes: nap.env.NAP_REAP_IDLE_MINUTES,
  // The tighter of the two, deliberately: a chat pane waiting on a turn whose worker died cannot
  // wait a minute, and an idle project can.
  janitorIntervalSeconds: nap.env.NAP_JANITOR_INTERVAL_SECONDS,
  maxSandboxesTotal: nap.env.NAP_MAX_SANDBOXES_TOTAL,
});
