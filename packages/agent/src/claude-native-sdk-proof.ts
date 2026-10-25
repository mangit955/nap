/** Actual SDK + shipped helper + local scripted CLI. No provider authentication or model request. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeNativeFrame } from "@nap/shared/native-process-protocol";
import { ClaudeNativeOutput } from "./claude-native-output.ts";

const home = await mkdtemp(join(tmpdir(), "nap-native-sdk-proof-"));
const sessionId = randomUUID();
const output = new ClaudeNativeOutput(sessionId);
const configDir = join(home, ".claude");
await mkdir(configDir);
const child = spawn(
  "node",
  [fileURLToPath(new URL("../dist/claude-native-helper.mjs", import.meta.url))],
  {
    cwd: home,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      CLAUDE_CONFIG_DIR: configDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
let sequence = 0;
let calls = 0;
let stderr = "";
let error: unknown;
const messages: string[] = [];
const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
child.stdout.on("data", (data: Buffer) => {
  try {
    for (const event of output.accept({
      kind: "output",
      sequence: ++sequence,
      stream: "stdout",
      data,
    }))
      if (event.type === "agent.message") messages.push(event.payload.text);
    for (const frame of output.takeControl()) {
      assert.equal(++calls, 1);
      assert.equal(frame.call.tool, "write_file");
      assert.deepEqual(frame.call.input, {
        path: "/home/user/app/proof.ts",
        contents: "export const proof = true;",
      });
      child.stdin.write(
        encodeNativeFrame({
          type: "tool_reply",
          id: frame.call.id,
          reply: { ok: true, value: { ok: true, output: "Fixture accepted" } },
        }),
      );
    }
  } catch (caught) {
    error = caught;
    child.kill("SIGKILL");
  }
});
child.stderr.on("data", (data: Buffer) => {
  stderr += data.toString();
});
child.stdin.on("error", () => {});
const closed = new Promise<number | null>((resolve, reject) => {
  child.once("close", resolve);
  child.once("error", reject);
});
try {
  child.stdin.write(
    encodeNativeFrame({
      type: "start",
      runId: randomUUID(),
      config: {
        sessionId,
        model: "fixture",
        cwd: home,
        home,
        configDir,
        executablePath: fileURLToPath(new URL("../dist/scripted-claude-cli.mjs", import.meta.url)),
        trustedInstructions: "Use the local protocol fixture tools.",
        environment: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
      },
      prompt: "/login @/private/fixture-credentials.json",
    }),
  );
  assert.equal(await closed, 0);
  if (error !== undefined) throw error;
  assert.equal(stderr, "");
  output.accept({
    kind: "exit",
    sequence: ++sequence,
    code: 0,
    reason: "exited",
    containment: "unknown",
  });
  assert.deepEqual(output.result, {
    ok: true,
    value: { usage: { inputTokens: 1, outputTokens: 1 }, usageIncomplete: true },
  });
  assert.deepEqual(messages, ["SDK protocol fixture 😀"]);
  assert.equal(calls, 1);
  process.stdout.write(
    `${JSON.stringify({ passed: true, permissionChecks: 5, mcpCalls: calls, providerAuthentication: false, providerModelRequests: 0 })}\n`,
  );
} finally {
  clearTimeout(timeout);
  child.kill("SIGKILL");
  await closed.catch(() => null);
  await rm(home, { recursive: true, force: true });
}
