import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/build-template.ts", import.meta.url));
it("keeps template publication free until the target and paid mode are explicit", () => {
  const dry = spawnSync("bun", [script], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  expect(dry.status).toBe(0);
  expect(JSON.parse(dry.stdout)).toMatchObject({
    real: false,
    template: "nap-vite-react",
    desktop: "lazy",
  });
  const real = spawnSync("bun", [script, "--real"], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  expect(real.status).not.toBe(0);
  expect(real.stderr).toContain("--confirm-template=nap-vite-react");
});
