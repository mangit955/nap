import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/desktop-driver.ts", import.meta.url));
it("describes the sandbox driver without starting any processes", () => {
  const run = spawnSync("bun", [script], { encoding: "utf8" });
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual({
    protocol: 1,
    operations: [
      "start",
      "act",
      "screenshot",
      "credentials",
      "cancel",
      "recording_begin",
      "recording_timestamp",
      "recording_finish",
      "recording_discard",
    ],
  });
});
it.each([
  "invalid",
  Buffer.from(
    JSON.stringify({
      id: "00000000-0000-4000-8000-000000000001",
      op: "act",
      action: { action: "javascript", text: "alert(1)" },
    }),
  ).toString("base64"),
  Buffer.from(JSON.stringify({ id: "../../bad", op: "cancel" })).toString("base64"),
])("rejects invalid commands before creating state or dispatching", (payload) => {
  const run = spawnSync("bun", [script, payload], { encoding: "utf8" });
  expect(run.status).not.toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({ ok: false, error: { code: "unavailable" } });
});
