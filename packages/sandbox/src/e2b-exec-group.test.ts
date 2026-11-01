/**
 * The scripts themselves, under a real `bash`, because whether they work is a fact about processes:
 * a stub can only prove which string was sent.
 *
 * Skipped where there is no `setsid`, which means macOS. CI is Linux, and the sandbox is Debian, so
 * these do run where they count. See docs/GOTCHAS.md for running them on Debian from a Mac.
 */

import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupedCommand, stopGroupCommand } from "./e2b-exec-group.ts";

const hasSetsid = spawnSync("setsid", ["--version"]).status === 0;

/** How each wrapped command gets started, which decides whether `setsid` has to fork. */
const STARTS: ReadonlyArray<{
  name: string;
  prefix: string;
  spawn: SpawnOptions;
  /** What the group's first process finds as its parent, which proves the case is the one named. */
  parent: string;
}> = [
  // How envd starts one: bash inherits a group it does not lead, and forks `setsid` into it.
  { name: "a shell in someone else's group", prefix: "", spawn: {}, parent: "bash" },
  // Leading the group changes nothing, because it is bash that leads and not the `setsid` it forks.
  { name: "a shell leading its group", prefix: "", spawn: { detached: true }, parent: "bash" },
  // Job control gives `setsid` a group of its own to lead, which is what makes it fork.
  { name: "a forking setsid", prefix: "set -m; ", spawn: {}, parent: "setsid" },
];

type Finished = { code: number | null; signal: string | null; stdout: string; stderr: string };

let directory: string;
let marker: string;
const started: ChildProcess[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "nap-exec-group-"));
  marker = join(directory, "marker");
});

afterEach(() => {
  // A failed assertion must not leave `sleep 300` behind.
  if (existsSync(marker)) spawnSync("bash", ["-c", stopGroupCommand(marker)]);
  for (const child of started.splice(0)) child.kill("SIGKILL");
  rmSync(directory, { recursive: true, force: true });
});

/** `bash -l -c <script>`, which is how the SDK runs every command. */
function runScript(script: string, options: SpawnOptions = {}) {
  const child = spawn("bash", ["-l", "-c", script], {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  started.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const finished = new Promise<Finished>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, finished };
}

/** Stops the group, the way the adapter does when it gives up. */
async function stop(): Promise<void> {
  expect((await runScript(stopGroupCommand(marker)).finished).code).toBe(0);
}

/** Running, as opposed to gone or a zombie: nothing reaps orphans when PID 1 is vitest in Docker. */
function isRunning(pid: number): boolean {
  try {
    return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));
  } catch {
    return false;
  }
}

/** Runs something that outlives its parent and says who it is, and waits until it has. */
async function startWithGrandchild(start: (typeof STARTS)[number]) {
  const pidFile = join(directory, "grandchild");
  const command = `sh -c 'echo $$ > ${pidFile}; sleep 300; true' & wait`;
  const running = runScript(`${start.prefix}${groupedCommand(command, marker)}`, start.spawn);
  await vi.waitFor(() =>
    expect(existsSync(pidFile) && readFileSync(pidFile, "utf8")).toMatch(/\d/),
  );
  const grandchild = Number(readFileSync(pidFile, "utf8"));
  expect(isRunning(grandchild)).toBe(true);
  return { ...running, grandchild };
}

describe.skipIf(!hasSetsid)("a command in its own process group", () => {
  describe.each(STARTS)("started by $name", (start) => {
    const run = (command: string) =>
      runScript(`${start.prefix}${groupedCommand(command, marker)}`, start.spawn).finished;

    it("is the case it claims to be", async () => {
      const { code, stdout } = await run("cat /proc/$PPID/comm");

      expect(code).toBe(0);
      expect(stdout.trim()).toBe(start.parent);
    });

    it("exits zero when the command does", async () => {
      expect((await run("true")).code).toBe(0);
    });

    it("exits with the command's own code", async () => {
      expect((await run("exit 3")).code).toBe(3);
    });

    it("exits non-zero when stopped, so a stopped check cannot read as a passing one", async () => {
      const { finished } = await startWithGrandchild(start);

      await stop();

      expect((await finished).code).not.toBe(0);
    });

    it("stops a grandchild, which signalling the top pid would not", async () => {
      const { grandchild } = await startWithGrandchild(start);

      await stop();

      await vi.waitFor(() => expect(isRunning(grandchild)).toBe(false));
    });
  });

  it("passes stdout and stderr through", async () => {
    const { code, stdout, stderr } = await runScript(
      groupedCommand("echo out; echo err >&2", marker),
    ).finished;

    expect(code).toBe(0);
    expect(stdout).toBe("out\n");
    expect(stderr).toBe("err\n");
  });

  it("keeps the command's own quoting, pipelines and lists", async () => {
    const command = `printf '%s\\n' "it's a \\"quote\\"" '$HOME' | tr a-z A-Z && echo "$((1 + 1))" || echo unreachable`;

    const { code, stdout } = await runScript(groupedCommand(command, marker)).finished;

    expect(code).toBe(0);
    expect(stdout).toBe(`IT'S A "QUOTE"\n$HOME\n2\n`);
  });

  it("removes its files once the command has finished", async () => {
    await runScript(groupedCommand("true", marker)).finished;

    expect(readdirSync(directory)).toEqual([]);
  });

  it("removes its files when stopped as well, if the wrapper outlives the group", async () => {
    const { finished } = await startWithGrandchild(STARTS[0] as (typeof STARTS)[number]);

    await stop();
    await finished;

    expect(readdirSync(directory)).toEqual(["grandchild"]);
  });

  it("never runs a command a stop got to first", async () => {
    const ran = join(directory, "ran");
    await stop();

    const { code } = await runScript(groupedCommand(`touch ${ran}`, marker)).finished;

    expect(code).toBe(143);
    expect(existsSync(ran)).toBe(false);
  });

  it("still stops the group after the provider has killed the wrapper", async () => {
    // What a deadline is: envd kills the pid it spawned and nothing else. That the grandchild
    // outlives this is the whole reason for the group, and it stays findable through the marker.
    const { child, grandchild } = await startWithGrandchild(STARTS[0] as (typeof STARTS)[number]);

    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(isRunning(grandchild)).toBe(true);

    await stop();

    await vi.waitFor(() => expect(isRunning(grandchild)).toBe(false));
  });

  it("copes with reading the marker between its creation and its contents", async () => {
    writeFileSync(marker, "");

    await stop();
  });

  it("is harmless when the command has already finished", async () => {
    await runScript(groupedCommand("true", marker)).finished;

    await stop();
  });
});
