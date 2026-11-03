/**
 * The two shell scripts that let a command be stopped along with everything it started.
 *
 * E2B's envd signals only the one process it spawned. Its kill, and the kill at a command's
 * deadline, both land on that pid, while the work (`tsc` under `bun run` under `bash`) sits further
 * down and carries on. So the command goes into a process group of its own, and stopping it is a
 * second command that signals the group.
 *
 * Both scripts rely on a file, the marker, because the SDK's pid cannot name the group: that pid is
 * the shell around `setsid`. And `setsid` forks if it is already a group leader, which job control
 * in a profile would make it, so its own pid cannot be relied on either. Inside the group, `$$` is
 * the group's id in both cases.
 *
 * The marker's `.stop` file closes the window where a stop beats the command to starting, in either
 * order. The command writes the marker and then looks for `.stop`; a stop writes `.stop` and then
 * looks for the marker. So at least one of them sees the other. A stop that finds the marker empty,
 * because it read between the create and the write, wrote `.stop` before the command looks for it.
 *
 * A wrapper the provider killed never reaches its cleanup, and a stop can arrive after one has
 * finished. Either leaves empty or nearly empty files in the sandbox's `/tmp`, which is cheaper than
 * a protocol for removing them.
 *
 * Both run under the `/bin/bash -l -c` every E2B command gets, which is why `kill --` is valid here:
 * it is `/bin/sh` on the sandbox that refuses it.
 */

import { shellQuote } from "@nap/shared/shell";

/**
 * `command`, run in a process group of its own, exiting with whatever it exited with.
 *
 * `--wait` is essential. Without it a forking `setsid` returns at once with 0, and a check that had
 * not even started would read as passed. The inner `bash -l` is the same shell the command would
 * have had unwrapped, profile included.
 */
export function groupedCommand(command: string, marker: string): string {
  const pidFile = shellQuote(marker);
  const stopFile = shellQuote(`${marker}.stop`);
  const inner = `echo $$ > ${pidFile}; test ! -f ${stopFile} || exit 143; exec bash -l -c "$0"`;
  return (
    `setsid --wait bash -c ${shellQuote(inner)} ${shellQuote(command)}; ` +
    `nap_status=$?; rm -f ${pidFile} ${stopFile}; exit "$nap_status"`
  );
}

/** Stops the group `groupedCommand` started under the same marker, or stops it ever starting. */
export function stopGroupCommand(marker: string): string {
  const pidFile = shellQuote(marker);
  const stopFile = shellQuote(`${marker}.stop`);
  return `touch ${stopFile}; if test -f ${pidFile}; then kill -KILL -- -$(cat ${pidFile}) 2>/dev/null || true; fi`;
}
