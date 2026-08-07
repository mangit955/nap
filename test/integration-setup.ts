/**
 * Loads `apps/api/.env` before any integration test runs.
 *
 * The integration suite needs real credentials, and the repo's convention is that those
 * live in `apps/api/.env` — Bun loads that file automatically for the API, but Vitest
 * runs under Node (see "Bun/Node split" in docs/PLAN.md), which does not. Without this,
 * every integration run would demand the variables be exported by hand, and the
 * "put it in .env" instruction the suites print would be wrong.
 *
 * Variables already present in the environment win, so an explicit
 * `E2B_API_KEY=… bun run test:integration` still overrides the file.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const ENV_FILE = join(import.meta.dirname, "..", "apps", "api", ".env");

if (existsSync(ENV_FILE)) {
  const before = { ...process.env };
  process.loadEnvFile(ENV_FILE);
  // loadEnvFile overwrites; restore anything that was set explicitly.
  for (const [key, value] of Object.entries(before)) {
    if (value !== undefined) process.env[key] = value;
  }
}
