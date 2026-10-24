import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseAppTestArgs } from "@nap/bench/app-test";
import { loadEnvFile } from "@nap/shared/env-file";
import { runAppTestCommand } from "./app-test-command.ts";

try {
  const args = process.argv.slice(2);
  if (parseAppTestArgs(args).real)
    loadEnvFile(join(import.meta.dirname, "../../api/.env"), process.env);
  const result = await runAppTestCommand({ args, env: process.env });
  mkdirSync(dirname(result.out), { recursive: true });
  writeFileSync(result.out, `${JSON.stringify(result.report, null, 2)}\n`);
  console.log(
    `${result.report.mode === "real" ? "Real app-test outcomes" : "Scripted apparatus only; no model capability measured"}. ${JSON.stringify(result.report.outcomes)}\n${result.out}`,
  );
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
