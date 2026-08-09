/**
 * Reading a `.env` file from a script.
 *
 * Bun auto-loads a `.env` from the working directory, which is the right behaviour for an
 * app and the wrong one for a script: credentials live in `apps/api/.env` by convention, and
 * a script run from anywhere else sees none of them. Node's `process.loadEnvFile` would do
 * the job, but Bun does not implement it — and these scripts run under Bun. So the file is
 * parsed here.
 *
 * Anything already exported wins. A variable set on the command line is a deliberate
 * override, and a file quietly beating it is the kind of thing that costs an hour.
 */

import { existsSync, readFileSync } from "node:fs";

/** Matches `KEY=value`, ignoring blank lines and anything that is not an assignment. */
const ASSIGNMENT = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i;

/** The assignments in a `.env` file's text, in file order, last one winning. */
export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of contents.split("\n")) {
    const match = ASSIGNMENT.exec(line);
    if (match === null) continue;

    const [, key, rawValue] = match;
    if (key === undefined || rawValue === undefined) continue;

    values[key] = rawValue.trim().replace(/^["'](.*)["']$/, "$1");
  }

  return values;
}

/** Loads a `.env` file into `env` if it exists, leaving variables already set alone. */
export function loadEnvFile(path: string, env: Record<string, string | undefined>): void {
  if (!existsSync(path)) return;

  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(path, "utf8")))) {
    if (env[key] !== undefined) continue;
    env[key] = value;
  }
}
