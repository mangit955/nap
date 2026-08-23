/**
 * A sweep on a timer, which two things in this package need and neither owns.
 *
 * The reaper puts away idle projects; the janitor closes out turns whose worker died. They run on
 * different intervals and answer to different clocks, and they want exactly the same loop — so the
 * loop lives here and neither of them holds it.
 *
 * Two things about it are load-bearing. **A tick that lands while the previous sweep is still
 * running is skipped**: a sweep talks to sandboxes and an object store over the network, and two
 * overlapping ones would try to tear the same project down twice. And **nothing here throws** —
 * an unhandled rejection ends the Bun process, which would turn one bad sweep into an outage for
 * every open tab.
 *
 * The first sweep is one interval away rather than immediate, so a process that is restarting
 * repeatedly does not sweep on every boot.
 */

export type SweepSchedule = {
  intervalMs: number;
  /** What to run on each tick — normally a closure over one of the package's sweeps. */
  sweep: () => Promise<unknown>;
  onError?: (error: unknown) => void;
  /**
   * Whether this timer is reason enough for the process to stay running.
   *
   * False everywhere a server or a claiming loop is what keeps the process alive, which is why it
   * is the default: an unreferenced timer never delays an exit that everything else is ready for.
   * True in the reaper process, where the ticks *are* the work — an unreferenced timer there would
   * leave a process with nothing referencing the event loop, and it would exit before its first
   * sweep.
   */
  holdProcessOpen?: boolean;
};

export function startSweeping(schedule: SweepSchedule): { stop: () => void } {
  let running = false;

  const timer = setInterval(() => {
    if (running) return;
    running = true;

    void schedule
      .sweep()
      .catch((error: unknown) => schedule.onError?.(error))
      .finally(() => {
        running = false;
      });
  }, schedule.intervalMs);

  // Normally not a reason to hold the process open by itself; the server or the claiming loop is
  // what keeps it alive. A process whose only job is sweeping asks for the opposite.
  if (schedule.holdProcessOpen !== true) timer.unref?.();

  return {
    stop: () => clearInterval(timer),
  };
}
