import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
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
