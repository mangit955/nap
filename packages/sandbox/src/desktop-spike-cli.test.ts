import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/desktop-spike.ts", import.meta.url));
function run(args: string[]) {
  return spawnSync("bun", [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
}
it("prints a free dry run without reading credentials or creating resources", () => {
  const result = run([]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    real: false,
    cpuCount: 2,
    memoryMB: 1024,
    sandboxTimeoutMs: 600000,
  });
});
it("requires the approved budget flag before any real operation", () => {
  const result = run(["--real"]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("--budget-usd=1");
});
it("refuses invalid resource sizes before reading credentials", () => {
  const result = run(["--real", "--budget-usd=1", "--memory=8192"]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("1024 or 4096");
});

it("uses exact loopback origin policy filters rather than unsupported path wildcards", () => {
  const start = fileURLToPath(new URL("../desktop/start-desktop.sh", import.meta.url));
  const result = spawnSync("bash", [start, "4321", "--print-policy"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    URLBlocklist: ["*", "chrome://*", "file://*"],
    URLAllowlist: ["http://.localhost:4321", "http://127.0.0.1:4321"],
  });
});
