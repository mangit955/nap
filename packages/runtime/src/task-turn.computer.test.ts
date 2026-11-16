/**
 * The workspace link, run in a real Linux machine: the one command of `runTaskTurn` whose
 * behaviour is a shell's, not this process's. Needs Docker; see the sandbox package's
 * `testing/docker-exec-channel.ts`.
 */

import { ChannelSandboxManager } from "@nap/sandbox/channel-sandbox-manager";
import {
  dockerExecChannel,
  removeContainer,
  startContainer,
} from "@nap/sandbox/testing/docker-exec-channel";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { linkWorkspaceCommand } from "./task-turn.ts";

const ID = "harbor-task";
const started: string[] = [];

afterEach(() => {
  for (const container of started.splice(0)) removeContainer(container);
});

function machine(workdir: string) {
  const container = startContainer(workdir);
  started.push(container);
  return new ChannelSandboxManager({ sandboxId: ID, channel: dockerExecChannel(container) });
}

describe("linkWorkspaceCommand in a Linux container", () => {
  it("makes the project path the task's working directory", async () => {
    const box = machine("/app/personal-site");
    expect(await box.exec(ID, linkWorkspaceCommand())).toMatchObject({
      ok: true,
      value: { exitCode: 0, stdout: "/app/personal-site" },
    });
    await box.writeFile(ID, `${PROJECT_ROOT_PATH}/regex.txt`, "x\n");
    expect(await box.readFile(ID, "/app/personal-site/regex.txt")).toEqual({
      ok: true,
      value: "x\n",
    });
    // Twice is harmless: a second trial step finds the link already there.
    expect(await box.exec(ID, linkWorkspaceCommand())).toMatchObject({
      ok: true,
      value: { exitCode: 0 },
    });
  }, 60_000);

  it("refuses a machine whose project path is already something else", async () => {
    const box = machine("/app");
    await box.exec(ID, `mkdir -p ${PROJECT_ROOT_PATH}`);
    const linked = await box.exec(ID, linkWorkspaceCommand());
    expect(linked).toMatchObject({ ok: true, value: { exitCode: 1 } });
    expect(linked.ok ? linked.value.stderr : "").toContain("is not the task's working directory");
  }, 60_000);

  it("refuses a machine whose working directory is the filesystem root", async () => {
    const box = machine("/");
    expect(await box.exec(ID, linkWorkspaceCommand())).toMatchObject({
      ok: true,
      value: { exitCode: 1 },
    });
  }, 60_000);
});
