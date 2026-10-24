import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Run alone: each mutation temporarily changes one assigned source file, then restores it.
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const output = process.argv[2] ?? "/tmp/nap-local-model-mutations";
mkdirSync(output, { recursive: true });
const model = "apps/api/scripts/computer-local-model.ts";
const fixture = "apps/api/scripts/computer-local-fixture.ts";
const tests = [
  "apps/api/scripts/computer-local-model.test.ts",
  "apps/api/scripts/computer-local-fixture.test.ts",
];
function runTests(name) {
  const run = spawnSync(
    "bunx",
    ["vitest", "run", "--project", "unit", "--maxWorkers=1", ...tests],
    { cwd: root, encoding: "utf8", timeout: 60_000 },
  );
  const log = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  writeFileSync(join(output, `${name}.log`), log);
  return { status: run.status, log };
}

if (runTests("baseline").status !== 0)
  throw new Error("Focused baseline failed; mutations were not run.");

const mutations = [
  [
    "provider-export",
    model,
    "export function computerLocalProvider",
    "function computerLocalProvider",
  ],
  [
    "fixture-export",
    fixture,
    "export function computerLocalAppSource",
    "function computerLocalAppSource",
  ],
  ["tool-error", model, "&& !block.isError", ""],
  ["unique-use", model, "uses === 1 && results === 1", "results === 1"],
  ["unique-result", model, "uses === 1 && results === 1", "uses === 1"],
  ["ordered-exchange", model, 'used && msg.role === "user"', 'msg.role === "user"'],
  ["tool-name", model, "block.name === call.name &&", ""],
  ["tool-input", model, "JSON.stringify(block.input) === JSON.stringify(call.input)", "true"],
  [
    "app-marker",
    model,
    `if (!text.includes('<main data-testid="notes-app">')) return "untested";`,
    "",
  ],
  ["unique-list", model, "lists.length === 1 ? lists[0]?.[1] : undefined", "lists[0]?.[1]"],
  [
    "input-frame",
    model,
    "if (!hasFrame(resultFor(request, state.call))) return finishUntested();",
    "if (false) return finishUntested();",
  ],
  [
    "current-note",
    model,
    'list.includes(`<li data-testid="saved-note">' + "$" + "{note}</li>`)",
    "list.length >= 0",
  ],
  [
    "missing-dom",
    model,
    'if (list === undefined) return "untested";',
    'if (list === undefined) return "failed";',
  ],
  ["explicit-repair", model, 'explicitRepair(request) ? "fixed" : "buggy"', '"fixed"'],
  ["expectation-first", model, 'result: "untested",', 'result: "passed",'],
  [
    "save-source",
    fixture,
    '"setNotes((saved) => [...saved, note]);"',
    '"setNotes((saved) => saved);"',
  ],
  [
    "bug-source",
    fixture,
    ': "setNotes((saved) => saved);"',
    ': "setNotes((saved) => [...saved, note]);"',
  ],
  [
    "declared-tool",
    model,
    "if (!request.tools.some((tool) => tool.name === next.call.name))",
    "if (false)",
  ],
];

let survivors = 0;
for (const [name, file, before, after] of mutations) {
  const path = join(root, file);
  const original = readFileSync(path, "utf8");
  if (!original.includes(before)) throw new Error(`Mutation ${name} no longer matches source.`);
  try {
    writeFileSync(path, original.replaceAll(before, after));
    const run = runTests(name);
    // Timeouts, signals and collection errors are not proof of a killed behavioral mutation.
    const killed =
      run.status !== null &&
      run.status !== 0 &&
      /(?:FAIL|failed)/.test(run.log) &&
      /AssertionError|TypeError/.test(run.log);
    process.stdout.write(
      `${name}\t${killed ? "caught" : "SURVIVED"}\texit=${run.status}\t${join(output, `${name}.log`)}\n`,
    );
    if (!killed) survivors += 1;
  } finally {
    writeFileSync(path, original);
  }
}
if (runTests("restored").status !== 0) throw new Error("The restored source failed focused tests.");
if (survivors > 0) process.exitCode = 1;
