/**
 * The adapter against a real Linux machine, reached the way Harbor's Docker environment reaches a
 * task's container: `docker exec <container> bash -c <command>`.
 *
 * The unit suite runs the same commands through the host's bash with deadlines switched off,
 * because a host may lack GNU `timeout`. This one is where a deadline is real: a command that
 * overruns must be stopped *inside* the machine, not merely abandoned by the caller, or a hung
 * foreground command keeps running under a task's hidden tests. Needs Docker, like the `db`
 * suite; slow enough to stay out of `test:fast`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChannelSandboxManager } from "./channel-sandbox-manager.ts";
import {
  dockerExecChannel,
  removeContainer,
  startContainer,
} from "./testing/docker-exec-channel.ts";

const ID = "harbor-task";

let container = "";

beforeAll(() => {
  container = startContainer("/app");
}, 120_000);

afterAll(() => {
  if (container !== "") removeContainer(container);
});

const box = () =>
  new ChannelSandboxManager({ sandboxId: ID, channel: dockerExecChannel(container) });

describe("ChannelSandboxManager in a Linux container", () => {
  it("round-trips bytes through the container's own base64", async () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 7) % 256);
    expect(await box().writeFileBytes(ID, "/app/data/blob.bin", bytes)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await box().readFileBytes(ID, "/app/data/blob.bin")).toEqual({ ok: true, value: bytes });
  }, 30_000);

  it("lists the task's directory with find when there is no git", async () => {
    await box().writeFile(ID, "/app/src/main.py", "print('hi')\n");
    const tree = await box().listTree(ID, "/app", { exclude: [], timeoutMs: 10_000 });
    expect(tree.ok ? tree.value.sort() : tree).toEqual(["/app/data/blob.bin", "/app/src/main.py"]);
  }, 30_000);

  it("runs in the container's working directory", async () => {
    expect(await box().exec(ID, "pwd")).toMatchObject({ ok: true, value: { stdout: "/app\n" } });
  }, 30_000);

  it("stops a command at its deadline inside the machine, not only on this side", async () => {
    const started = Date.now();
    const ran = await box().exec(ID, "sleep 300 # nap-deadline-probe", undefined, {
      timeoutMs: 1_000,
    });
    expect(ran).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(Date.now() - started).toBeLessThan(10_000);

    // No process in the container is still running the command. The bracket keeps the probe's
    // own command line from matching its pattern.
    const survivors = await box().exec(
      ID,
      "grep -l 'nap-deadline-[p]robe' /proc/[0-9]*/cmdline 2>/dev/null || true",
    );
    expect(survivors).toMatchObject({ ok: true, value: { stdout: "" } });
  }, 30_000);

  it("reads a file back exactly from a machine whose shell warns on every command", async () => {
    // A locale the image does not have: bash prints a warning on stderr each time it starts,
    // which Harbor hands back inside stdout.
    const noisy = startContainer("/app", { LC_ALL: "en_US.UTF-8" });
    try {
      const machine = new ChannelSandboxManager({
        sandboxId: ID,
        channel: dockerExecChannel(noisy),
      });
      const bytes = Uint8Array.from({ length: 4_096 }, (_, index) => (index * 31) % 256);
      await machine.writeFileBytes(ID, "/app/blob.bin", bytes);
      expect(await machine.readFileBytes(ID, "/app/blob.bin")).toEqual({ ok: true, value: bytes });
      expect(await machine.listFiles(ID, "/app")).toEqual({
        ok: true,
        value: [{ path: "/app/blob.bin", type: "file" }],
      });
    } finally {
      removeContainer(noisy);
    }
  }, 60_000);
});
