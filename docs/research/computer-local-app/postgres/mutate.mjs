// Run from the repo root. Only isolated CLI/SQL stubs are used; restore source on every exit.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const source = "packages/db/src/testing/docker-postgres.ts";
const original = readFileSync(source, "utf8");
const command = [
  "vitest",
  "run",
  "--project",
  "unit",
  "packages/db/src/testing/docker-postgres.test.ts",
];
const cases = [
  ["original rollback RED", null, "surfaces rollback failure"],
  [
    "kill allocating CLI",
    ['child.kill("SIGKILL");', 'child.kill("SIGTERM");'],
    "aborts an allocating CLI",
  ],
  ["startup rollback", ["await stop();", "await Promise.resolve();"], "aborts an allocating CLI"],
  ["exact resource absence", ["if (found.trim())", "if (false)"], "surfaces rollback failure"],
  ["SQL cancellation", ["await untilAborted(work, signal);", "await work;"], "interrupts stalled"],
];
try {
  for (const [name, mutation, test] of cases) {
    let changed;
    if (mutation === null) {
      const result = spawnSync(
        "git",
        ["show", "16c2d65:packages/db/src/testing/docker-postgres.ts"],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.equal(result.status, 0, result.stderr);
      changed = result.stdout;
    } else {
      const [old, replacement] = mutation;
      assert.equal(original.split(old).length, 2, `${name}: unique mutation anchor`);
      changed = original.replace(old, replacement);
    }
    writeFileSync(source, changed);
    const result = spawnSync("bunx", [...command, "-t", test], {
      encoding: "utf8",
      timeout: 25000,
    });
    console.log(`\n=== ${name}: exit ${result.status} ===`);
    console.log(result.stdout + result.stderr);
    assert.equal(result.error, undefined, "test must fail by assertion, not process timeout");
    assert.notEqual(result.status, 0, `${name}: mutation survived`);
    writeFileSync(source, original);
  }
} finally {
  writeFileSync(source, original);
}
