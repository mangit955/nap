/**
 * Which checks a project has, read from the project itself.
 *
 * Not from the model — a model asked which checks exist will confidently name a `test` script
 * that was never written — and not from a hardcoded list, because a list that assumes four
 * scripts turns three of them into failures on every project that has one.
 *
 * **A script nobody declared is absent, not failed.** That gap is the reason this function
 * exists at all: a fresh project with no `test` script has not failed its tests, and charging
 * the missing script as a failure opens a repair loop that no amount of repairing can close.
 * `CheckOutcome` in `@nap/shared` carries the same three answers onward into the event log.
 *
 * **Discovery produces a command, not a script name.** The Vite template's `"test": "vitest"`
 * runs in watch mode and never exits, so a verifier handed the name alone would hang a turn
 * on the most ordinary project there is. What a check *is* here is something that runs and
 * finishes, which means the watch-mode question is answered once, here, rather than by every
 * caller.
 *
 * Pure: contents in, ordered checks out. Reading the file is the caller's, which is what lets
 * every case below be a literal.
 */

import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { z } from "zod";

/**
 * The checks a project may have, cheapest first.
 *
 * Order is part of the answer rather than a caller's choice: verification stops at the first
 * failure, so running the fastest and most specific check first is what keeps a repair turn
 * pointed at the type error rather than at the build error downstream of it.
 */
export const CHECK_NAMES = ["typecheck", "lint", "build", "test"] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export type DiscoveredCheck =
  /** The project declares this script, and this is what running it once looks like. */
  | { name: CheckName; state: "runnable"; command: string }
  /** The project does not declare it. Nobody will ask, and nothing failed. */
  | { name: CheckName; state: "absent" };

/**
 * Loose, because a project's `package.json` is the user's file and almost none of it is ours.
 * Script values are `unknown` rather than `string` for the same reason: a malformed entry
 * makes that one check absent instead of rejecting the whole manifest.
 */
const PackageJsonSchema = z.looseObject({
  scripts: z.record(z.string(), z.unknown()).optional(),
});

export function discoverChecks(packageJsonContents: string): DiscoveredCheck[] {
  const scripts = readScripts(packageJsonContents);

  return CHECK_NAMES.map((name) => {
    const script = scripts[name];
    if (typeof script !== "string" || script.trim() === "") return { name, state: "absent" };

    return { name, state: "runnable", command: commandFor(name, script) };
  });
}

/**
 * Every check runs through the project's own script rather than the tool the script names.
 *
 * `bun run lint` and not `bunx biome check .`: the script is what the project means by
 * linting, flags and all, and re-deriving it would make the verifier disagree with the
 * developer about what passing means.
 */
function commandFor(name: CheckName, script: string): string {
  const command = `cd ${PROJECT_ROOT_PATH} && bun run ${name}`;

  // Extra arguments reach the script itself — `bun run test --run` is `vitest --run`.
  return needsRunFlag(script) ? `${command} --run` : command;
}

/** Vitest itself, however it is spelled: bare, path-qualified, or launched by a runner. */
const VITEST = /^(.*\/)?vitest$/;

/**
 * Vitest already asked to run once: the `run` subcommand, `--run`, or watching turned off.
 *
 * Read from the arguments *after* the `vitest` token rather than from the whole line, because
 * the launchers people use to reach vitest are themselves spelled with the word: `bun run
 * vitest` and `npm run vitest` both contain a bare `run` that belongs to the runner, and
 * reading it as vitest's leaves the watcher running and hangs the turn.
 *
 * Matched rather than trusted to be harmless, because appending a flag a project already set
 * is how a command grows two contradictory copies of the same option.
 */
const ASKED_TO_RUN_ONCE = /(^|\s)(run|--run|--watch=false|--watch false)(\s|$)/;

/**
 * Whether this script would sit there waiting for a file to change.
 *
 * Only vitest is recognised, because it is the one this repo's own template ships and the
 * one that watches *by default* — jest and node's runner both need to be asked. This is the
 * place a second watcher gets taught, and until then an unrecognised one is a check that
 * runs until whatever deadline the caller imposed.
 *
 * Only the script's **last** command is examined, because that is where an appended argument
 * lands: `bun run test --run` on a `"lint && vitest"` script is `lint && vitest --run`, and
 * on a `"vitest && lint"` one the flag would go to `lint`, which fixes nothing and confuses
 * something. A watcher hidden mid-pipeline is left alone rather than mis-flagged.
 *
 * `vitest --watch` still gets the flag, and `vitest --watch --run` was run against vitest
 * 4.1.10 to confirm it exits rather than assumed to: a script that asks for both is better
 * resolved towards terminating than left to hang a turn.
 */
function needsRunFlag(script: string): boolean {
  const last = script.split(/&&|\|\||;|\|/).at(-1) ?? script;

  const tokens = last.trim().split(/\s+/);
  const vitest = tokens.findIndex((token) => VITEST.test(token));
  if (vitest === -1) return false;

  return !ASKED_TO_RUN_ONCE.test(tokens.slice(vitest + 1).join(" "));
}

function readScripts(packageJsonContents: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonContents);
  } catch {
    return {};
  }

  const manifest = PackageJsonSchema.safeParse(parsed);
  return manifest.success ? (manifest.data.scripts ?? {}) : {};
}
