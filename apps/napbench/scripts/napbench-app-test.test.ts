import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("runs the actual free CLI and writes all four apparatus reports", () => {
  const directory = mkdtempSync(join(tmpdir(), "nap-app-cli-"));
  try {
    const path = join(directory, "report.json");
    const result = spawnSync(
      "bun",
      ["run", "apps/napbench/scripts/napbench-app-test.ts", `--out=${path}`],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(path, "utf8"));
    expect(report.mode).toBe("scripted");
    expect(report.modelCapability).toBeNull();
    expect(report.runs).toHaveLength(4);
    expect(report.apparatus).toEqual({
      bugsCaught: 0,
      bugsTested: 2,
      correctAccepted: 2,
      correctTested: 2,
      unmeasured: 0,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

it.each(["--real", "--rael", "--task=unknown"])(
  "rejects %s without starting infrastructure",
  (arg) => {
    const result = spawnSync("bun", ["run", "apps/napbench/scripts/napbench-app-test.ts", arg], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    if (arg === "--real") expect(result.stderr).toContain("Real app-test evaluation is pending");
  },
);
