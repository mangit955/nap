import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/computer-image-spike.ts", import.meta.url));
it("keeps model probes free unless --real and the approved budget are explicit", () => {
  const dry = spawnSync("bun", [script], { encoding: "utf8", env: { PATH: process.env.PATH } });
  expect(dry.status).toBe(0);
  expect(JSON.parse(dry.stdout)).toMatchObject({
    real: false,
    requestsPerModel: 1,
    maxOutputTokens: 512,
  });
  const real = spawnSync("bun", [script, "--real"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  expect(real.status).not.toBe(0);
  expect(real.stderr).toContain("--budget-usd=1");
});

it("rejects an unverified screenshot before reading model credentials", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const output = mkdtempSync(join(tmpdir(), "nap-image-preflight-"));
  try {
    writeFileSync(
      join(output, "desktop.json"),
      JSON.stringify({ status: "completed", marker: "NAP-12345678" }),
    );
    const run = spawnSync("bun", [script, "--real", "--budget-usd=1", `--output=${output}`], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("markerVerified");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
