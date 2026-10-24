/** Checks the actual shipped entry point without a valid start, a credential or a model request. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const artifact = fileURLToPath(new URL("../dist/claude-native-helper.mjs", import.meta.url));
for (const input of [
  '{"type":"start","config":{}}\n',
  '{"type":',
  JSON.stringify({
    type: "tool_reply",
    id: "a".repeat(64),
    reply: { ok: true, value: { ok: true, output: "fixture" } },
  }) + "\n",
]) {
  const result = spawnSync("node", [artifact], {
    input,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}
process.stdout.write(
  `${JSON.stringify({ passed: true, invalidInputs: 3, subscriptionAuthentication: false, modelRequests: 0 })}\n`,
);
