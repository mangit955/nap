/**
 * What the runtime asks of a committed turn, and what it does with the answer.
 *
 * The pieces underneath are `@nap/verify`'s and tested there — discovery from a manifest, the
 * cheapest-first order, the short circuit. What is tested here is the composition: that the
 * manifest is read from the project rather than assumed, that a manifest nobody could read
 * runs nothing at all, and that a result becomes an event payload without losing the one thing
 * a repair turn needs from it.
 */

import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { failureOf, toVerifiedChecks, verifyTurn } from "./verify-turn.ts";

const PROJECT_ID = "4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const PORT = 5173;

/** A sandbox that answers no command, for the run that learns nothing about the project. */
class UnreachableSandboxManager extends InMemorySandboxManager {
  override async exec(): Promise<{ ok: false; error: { code: "destroyed"; message: string } }> {
    return { ok: false, error: { code: "destroyed", message: "the sandbox is gone" } };
  }
}

const MANIFEST = JSON.stringify({
  scripts: { typecheck: "tsc --noEmit", build: "vite build" },
});

let sandbox: InMemorySandboxManager;
let sandboxId: string;

async function newSandbox(manager: InMemorySandboxManager): Promise<string> {
  const created = await manager.create(PROJECT_ID);
  if (!created.ok) throw new Error("the fake refused to create a sandbox");
  return created.value.id;
}

beforeEach(async () => {
  sandbox = new InMemorySandboxManager({ serves: [PORT] });
  sandboxId = await newSandbox(sandbox);
  await sandbox.writeFile(sandboxId, `${PROJECT_ROOT_PATH}/package.json`, MANIFEST);
});

/** Only the checks a project declared were actually asked; the rest report themselves absent. */
function commandsRun(): string[] {
  return sandbox.commands(sandboxId);
}

describe("verifyTurn", () => {
  it("runs the checks the project declares, and reports the rest absent", async () => {
    sandbox.script(/bun run typecheck/, { exitCode: 0 }).script(/bun run build/, { exitCode: 0 });

    const result = await verifyTurn({ sandbox, sandboxId, previewPort: PORT });

    expect(result.verdict).toBe("passed");
    expect(result.checks.map((check) => [check.name, check.outcome])).toEqual([
      ["typecheck", "passed"],
      ["lint", "absent"],
      ["build", "passed"],
      ["test", "absent"],
      ["preview", "passed"],
    ]);
    expect(commandsRun()).toHaveLength(2);
  });

  it("fails on the first check that says no, and asks nothing after it", async () => {
    sandbox.script(/bun run typecheck/, { exitCode: 2, stderr: "App.tsx(3,1): error TS2304" });

    const result = await verifyTurn({ sandbox, sandboxId, previewPort: PORT });

    expect(result.verdict).toBe("failed");
    expect(commandsRun()).toEqual([expect.stringContaining("bun run typecheck")]);
  });

  it("probes the preview, so an application that builds but does not run still fails", async () => {
    // Nothing serving and curl refused inside: the app did not start, which is the agent's.
    const quiet = new InMemorySandboxManager();
    const quietId = await newSandbox(quiet);
    await quiet.writeFile(quietId, `${PROJECT_ROOT_PATH}/package.json`, MANIFEST);
    quiet
      .script(/bun run typecheck/, { exitCode: 0 })
      .script(/bun run build/, { exitCode: 0 })
      .script(/curl/, { exitCode: 7 });

    const result = await verifyTurn({
      sandbox: quiet,
      sandboxId: quietId,
      previewPort: PORT,
      previewTimeoutMs: 10,
    });

    expect(result.verdict).toBe("failed");
    expect(result.checks.at(-1)).toMatchObject({ name: "preview", outcome: "failed" });
  });

  it("errors, having run nothing, when the project's manifest cannot be read", async () => {
    // No manifest means no answer about which checks exist — not an answer that none do. Running
    // the four names anyway would charge a project for scripts nobody claimed it had.
    const bare = new InMemorySandboxManager({ serves: [PORT] });
    const bareId = await newSandbox(bare);

    const result = await verifyTurn({ sandbox: bare, sandboxId: bareId, previewPort: PORT });

    expect(result.verdict).toBe("errored");
    expect(result.checks.every((check) => check.outcome === "absent")).toBe(true);
    expect(bare.commands(bareId)).toEqual([]);
  });

  it("errors when the sandbox refuses to run a check", async () => {
    // A sandbox that went away mid-run learned nothing about the project, so its checks come
    // back absent and the verdict routes it away from being recorded as a verification.
    const gone = new UnreachableSandboxManager({ serves: [PORT] });
    const goneId = await newSandbox(gone);
    await gone.writeFile(goneId, `${PROJECT_ROOT_PATH}/package.json`, MANIFEST);

    const result = await verifyTurn({ sandbox: gone, sandboxId: goneId, previewPort: PORT });

    expect(result.verdict).toBe("errored");
    expect(result.checks.every((check) => check.outcome === "absent")).toBe(true);
  });
});

describe("toVerifiedChecks", () => {
  it("keeps what a failing check said, on the stream it said it", async () => {
    sandbox.script(/bun run typecheck/, {
      exitCode: 2,
      stdout: "checking",
      stderr: "error TS2304",
    });

    const result = await verifyTurn({ sandbox, sandboxId, previewPort: PORT });
    const [typecheck] = toVerifiedChecks(result.checks);

    expect(typecheck).toStrictEqual({
      name: "typecheck",
      outcome: "failed",
      output: "checking\nerror TS2304",
    });
  });

  it("records nothing for a check that passed or was never asked", async () => {
    sandbox.script(/bun run typecheck/, { exitCode: 0 }).script(/bun run build/, { exitCode: 0 });

    const result = await verifyTurn({ sandbox, sandboxId, previewPort: PORT });

    expect(toVerifiedChecks(result.checks).every((check) => check.output === null)).toBe(true);
  });
});

describe("failureOf", () => {
  it("flattens a live run's finding into what a prompt and the log both read", async () => {
    // The same three fields a failure recorded before a restart has — which is the whole
    // reason this shape exists, since a repair turn may be prompted from either.
    sandbox.script(/bun run typecheck/, { exitCode: 2, stdout: "", stderr: "error TS2304" });

    const result = await verifyTurn({ sandbox, sandboxId, previewPort: PORT });
    const failed = result.checks.find((check) => check.outcome === "failed");
    if (failed === undefined) throw new Error("expected a failing check");

    expect(failureOf(failed)).toStrictEqual({
      name: "typecheck",
      detail: "exit 2",
      output: "error TS2304",
    });
  });

  it("says a silent failure printed nothing rather than an empty string", async () => {
    sandbox.script(/bun run typecheck/, { exitCode: 1, stdout: "", stderr: "" });

    const result = await verifyTurn({ sandbox, sandboxId, previewPort: PORT });
    const failed = result.checks.find((check) => check.outcome === "failed");
    if (failed === undefined) throw new Error("expected a failing check");

    expect(failureOf(failed).output).toBeNull();
  });
});
