import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import {
  InMemorySandboxManager,
  type ScriptedExecResponse,
} from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { RepositorySource } from "@nap/shared/ports/repository-workspace";
import { expect, it, vi } from "vitest";
import { prepareRepositoryEnvironment } from "./repository-environment.ts";

const source: RepositorySource = {
  setupCommand: "bun install --frozen-lockfile",
  devCommand: "bun run dev --host 0.0.0.0",
  previewPort: 3000,
  initialBundle: async () => ({ ok: true, value: new Uint8Array() }),
};

it("runs owner setup and starts the configured dev command", async () => {
  const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
  const created = await sandbox.create("project");
  if (!created.ok) throw new Error(created.error.message);
  expect(
    await prepareRepositoryEnvironment({ sandbox, sandboxId: created.value.id, source }),
  ).toMatchObject({ ok: true });
  const commands = sandbox.commands(created.value.id).join("\n");
  expect(commands).toContain("bun install --frozen-lockfile");
  expect(commands).toContain("bun run dev --host 0.0.0.0");
  expect(await sandbox.readFile(created.value.id, "/tmp/nap-repository-preview.json")).toEqual({
    ok: true,
    value: JSON.stringify({ previewPort: 3000 }),
  });
});

it("does not accept setup when the running preview configuration cannot be recorded", async () => {
  const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
  const created = await sandbox.create("project");
  if (!created.ok) throw new Error(created.error.message);
  vi.spyOn(sandbox, "writeFile").mockResolvedValue({
    ok: false,
    error: { code: "unavailable", message: "write failed" },
  });
  expect(
    await prepareRepositoryEnvironment({ sandbox, sandboxId: created.value.id, source }),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("preview configuration") },
  });
});

it("does not run setup or start a process after cancellation", async () => {
  const sandbox = new InMemorySandboxManager();
  const created = await sandbox.create("project");
  if (!created.ok) throw new Error(created.error.message);
  const result = await prepareRepositoryEnvironment({
    sandbox,
    sandboxId: created.value.id,
    source,
    signal: AbortSignal.abort(),
  });
  expect(result.ok).toBe(false);
  expect(sandbox.commands(created.value.id)).toEqual([]);
});

it("rejects setup that changes tracked files or leaves unignored output before preview starts", async () => {
  const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) }).script(
    /git -c core\.hooksPath=\/dev\/null status --porcelain/,
    { exitCode: 0, stdout: " M bun.lock\n?? generated-output/\n" },
  );
  const created = await sandbox.create("project");
  if (!created.ok) throw new Error(created.error.message);
  const result = await prepareRepositoryEnvironment({
    sandbox,
    sandboxId: created.value.id,
    source,
  });
  expect(result).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("preserve tracked files") },
  });
  expect(sandbox.commands(created.value.id).some((command) => command.includes("nohup"))).toBe(
    false,
  );
});

it("fails closed when setup's clean tree cannot be checked", async () => {
  const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) }).script(
    /git -c core\.hooksPath=\/dev\/null status --porcelain/,
    { exitCode: 128 },
  );
  const created = await sandbox.create("project");
  if (!created.ok) throw new Error(created.error.message);
  expect(
    await prepareRepositoryEnvironment({ sandbox, sandboxId: created.value.id, source }),
  ).toMatchObject({ ok: false });
  expect(sandbox.commands(created.value.id).some((command) => command.includes("nohup"))).toBe(
    false,
  );
});

it("terminates setup's process group and does not start preview when cancelled during setup", async () => {
  const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
  const created = await sandbox.create("project");
  if (!created.ok) throw new Error(created.error.message);
  const controller = new AbortController();
  sandbox.script(/setsid timeout/, () => {
    controller.abort();
    return { exitCode: 143 };
  });
  const result = await prepareRepositoryEnvironment({
    sandbox,
    sandboxId: created.value.id,
    source,
    signal: controller.signal,
  });
  expect(result).toMatchObject({ ok: false, error: { code: "cancelled" } });
  const commands = sandbox.commands(created.value.id);
  expect(
    commands.some(
      (command) =>
        command.startsWith("touch /tmp/nap-setup-") && command.includes("kill -TERM -- -"),
    ),
  ).toBe(true);
  expect(commands.some((command) => command.includes("nohup"))).toBe(false);
});

async function setupRunning(script: ScriptedExecResponse) {
  const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) }).script(
    /setsid timeout/,
    script,
  );
  const created = await sandbox.create("project");
  if (!created.ok) throw new Error(created.error.message);
  return { sandbox, sandboxId: created.value.id };
}

it("lets setup run for most of the ten minutes it was promised", async () => {
  const { sandbox, sandboxId } = await setupRunning({ runsForMs: 9 * 60_000 });

  expect(await prepareRepositoryEnvironment({ sandbox, sandboxId, source })).toMatchObject({
    ok: true,
  });
});

it("leaves the setup script's own ten-minute timeout to fire first, and reports it", async () => {
  // `timeout 600s` signals at ten minutes, but exits with 124 only once what it signalled has died,
  // a few seconds later. A provider deadline at or before ten minutes would end the call first, take
  // the exit code with it and turn this into a generic failure.
  const { sandbox, sandboxId } = await setupRunning({ runsForMs: 605_000, exitCode: 124 });

  const result = await prepareRepositoryEnvironment({ sandbox, sandboxId, source });

  expect(sandbox.commands(sandboxId).join("\n")).toContain("timeout 600s");
  expect(result).toMatchObject({
    ok: false,
    error: { code: "unavailable", message: expect.stringContaining("10 minutes") },
  });
});

it("stops waiting on setup when cancelled, leaving the stopping to the setup script's own kill", async () => {
  const { sandbox, sandboxId } = await setupRunning({ exitCode: 0 });
  const { signal } = new AbortController();

  await prepareRepositoryEnvironment({ sandbox, sandboxId, source, signal });

  const setup = sandbox.execs(sandboxId).find((exec) => /setsid timeout/.test(exec.command));
  expect(setup?.options.signal).toBe(signal);
  // The script kills the whole process group through its pid file; a provider kill of its shell
  // could leave that group running, with nothing left holding the pid.
  expect(setup?.options.stopOnGiveUp).toBeUndefined();
});

it("starts the dev server without holding the start command open until the server exits", async () => {
  // E2B runs a command with `bash -c` and answers once that shell's output pipes close, giving up
  // after 60 seconds. A dev server runs until stopped, so a start command that leaves it holding
  // those pipes never answers, and every repository with a dev command fails to start. Run the real
  // command through bash, not `/bin/sh`: dash, CI's `/bin/sh`, hands the pipe over where bash does
  // not, so it passes the broken command. The dev command never exits on its own, and its own
  // command line carries a marker so the server itself can be found and stopped.
  const marker = `${30_000 + Math.floor(Math.random() * 9_000)}.${Date.now() % 1_000_000}`;
  const server = `sleep ${marker}`;
  const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
  const created = await sandbox.create("project");
  if (!created.ok) throw new Error(created.error.message);
  await prepareRepositoryEnvironment({
    sandbox,
    sandboxId: created.value.id,
    source: { ...source, devCommand: server },
  });
  const start = sandbox.commands(created.value.id).find((command) => command.includes(server));
  if (start === undefined) throw new Error("the dev command was never started");
  const workdir = await mkdtemp(join(tmpdir(), "nap-repository-"));
  const log = join(workdir, "preview.log");

  const command = start
    .replaceAll(TEMPLATE_WORKDIR, workdir)
    .replaceAll("/tmp/nap-preview.log", log);
  const shell = spawn("bash", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });

  try {
    shell.stdout.resume();
    shell.stderr.resume();
    // `close` waits for the output pipes, not just the shell's exit: what E2B waits for.
    const answered = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      shell.on("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
      shell.on("error", reject);
    });
    const serverRunning = spawnSync("pgrep", ["-f", server]).status === 0;

    expect(answered).toBe(true);
    expect(serverRunning).toBe(true);
    // Both paths were rewritten, so the server ran where the real one would and logged there.
    expect(existsSync(log)).toBe(true);
  } finally {
    shell.kill("SIGKILL");
    spawnSync("pkill", ["-f", server]);
    await rm(workdir, { recursive: true, force: true });
  }
}, 20_000);
