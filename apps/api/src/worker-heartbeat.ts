/**
 * How a worker pod proves it is still claiming, to something that cannot ask it over HTTP.
 *
 * A worker serves nothing — no port, no route, no Service — so the liveness question a platform
 * can ask is not "does it answer?" but "is its claim loop still going round?". A wedged loop
 * leaves a pod that is up, holds no leases and runs nothing, and every other kind of probe reports
 * it healthy. The claim loop calls this each time round; the probe in
 * `infra/k8s/base/deployment-worker.yaml` looks at the file's age and restarts a pod whose loop
 * has been silent for two minutes.
 *
 * A file rather than a metric or a port, because it needs no second server inside the process and
 * no scrape: `stat` is the whole reader. Kept out of `@nap/runtime`, which knows nothing about
 * pods, filesystems or how this deployment is supervised.
 */

import { writeFileSync } from "node:fs";

/**
 * How often the file is actually written, however often the loop ticks.
 *
 * The loop comes round several times a second when the queue is empty, and a write per tick would
 * be thousands of pointless syscalls an hour for a signal whose whole resolution is "within the
 * last two minutes". Five seconds is twenty-four times finer than the probe's threshold, so the
 * throttle can never be what makes a healthy worker look dead.
 */
export const HEARTBEAT_WRITE_INTERVAL_MS = 5_000;

export type HeartbeatWriterOptions = {
  /** Injected so the throttle can be tested against a clock rather than against a wait. */
  now?: () => number;
  /** Injected so a test asserts on how often the file is touched, not on a disk. */
  write?: (path: string) => void;
};

/**
 * A function to call on every claim tick, which touches `path` at most every few seconds.
 *
 * Errors are deliberately not swallowed. A worker that cannot write this file has a probe that
 * will not pass, and that is the honest outcome: the caller logs it, and the pod is replaced by
 * one whose filesystem works.
 */
export function createHeartbeatWriter(
  path: string,
  options: HeartbeatWriterOptions = {},
): () => void {
  const now = options.now ?? Date.now;
  // The empty contents are the point: the signal is the modification time, and truncating each
  // time keeps the file at zero bytes for the life of the pod.
  const write = options.write ?? ((target: string) => writeFileSync(target, ""));

  let lastWrite: number | undefined;

  return () => {
    const at = now();
    // Written on the very first tick, so a pod becomes live as soon as its loop starts rather than
    // after an interval in which its startup probe is the only thing holding liveness off.
    if (lastWrite !== undefined && at - lastWrite < HEARTBEAT_WRITE_INTERVAL_MS) return;
    lastWrite = at;
    write(path);
  };
}
