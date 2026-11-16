import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * The integration project spends money (real E2B, real models), so `vitest.config.ts` defines it
 * only when NAP_INTEGRATION is set, which `bun run test:integration` does. Filtering by name could
 * not keep it out: Vitest reads positional arguments as substring filters across every project,
 * matches `--project` case-insensitively, and takes `!` as negation. Each spelling below once
 * collected the paid suite; this asks the real CLI what it would run.
 */

const repoRoot = join(import.meta.dirname, "..");
const vitest = join(repoRoot, "node_modules", ".bin", "vitest");
const run = promisify(execFile);

async function listFiles(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout, stderr } = await run(vitest, ["list", "--filesOnly", ...args], {
      cwd: repoRoot,
      env,
    });
    return stdout + stderr;
  } catch (error) {
    // An unmatched `--project` exits non-zero; its output is still the answer.
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    return stdout + stderr;
  }
}

const { NAP_INTEGRATION: _ignored, ...plainEnv } = process.env;

describe("the integration project is opt-in", () => {
  it.each([
    [[".test.ts"]],
    [["--project", "!unit"]],
    [["--project", "INTEGRATION"]],
    [["--project", "integration"]],
  ])(
    "collects no integration file for vitest list %j",
    async (args) => {
      const output = await listFiles(args, plainEnv);
      // Not vacuous: the run either listed files or named the project it could not find.
      expect(output).toMatch(/^\[\w+\] |No projects matched/m);
      expect(output).not.toMatch(/^\[integration\] /m);
    },
    60_000,
  );

  it("collects it when NAP_INTEGRATION is set", async () => {
    const output = await listFiles(["--project", "integration"], {
      ...plainEnv,
      NAP_INTEGRATION: "1",
    });
    expect(output).toMatch(/^\[integration\] /m);
  }, 60_000);
});
