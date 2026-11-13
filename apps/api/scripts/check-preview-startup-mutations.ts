/** Free, local mutation checks. Run with `bun run apps/api/scripts/check-preview-startup-mutations.ts`. */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const runtime = "packages/runtime/src/single-agent-runtime.ts";
const path = resolve(root, runtime);
const test = "apps/api/src/projects/open-startup.test.ts";
const clean = spawnSync("git", ["diff", "HEAD", "--exit-code", "--", runtime], { cwd: root });
if (clean.status !== 0) throw new Error("Commit or save runtime changes before running mutations.");
const original = readFileSync(path, "utf8");

const mutations = [
  {
    name: "context waits for public preview readiness",
    before: "      });\n\n      run = {",
    after: "      });\n      await sink.settle();\n\n      run = {",
    pattern: "starts context and the model independently",
  },
  {
    name: "resume waits for thumbnail capture",
    before:
      "    await this.#options.thumbnails?.request({ projectId, sandboxId, port: previewPort, ...wait });",
    after:
      "    await this.#options.thumbnails?.request({ projectId, sandboxId, port: previewPort, ...wait });\n" +
      "    while ((this.#options.thumbnails?.pending ?? 0) > 0) await new Promise((done) => setTimeout(done, 1));",
    pattern: "announces an open with no message under its lease",
  },
  {
    name: "resume returns with an unowned preview announcement",
    before:
      "      await sink.settle().catch(() => {});\n    }\n  }\n\n  /**\n" +
      "   * Picking a job back up where a process restart left it.",
    after:
      "      await sink.drain().catch(() => {});\n    }\n  }\n\n  /**\n" +
      "   * Picking a job back up where a process restart left it.",
    pattern: "announces an open with no message under its lease",
  },
  {
    name: "preview readiness ignores resume cancellation",
    before: "      signal,\n    );\n    sink.eventually(",
    after: "      undefined,\n    );\n    sink.eventually(",
    pattern: "discards a cancelled resume",
  },
];

for (const mutation of mutations) {
  if (original.split(mutation.before).length !== 2)
    throw new Error(`Mutation no longer matches exactly once: ${mutation.name}`);
  try {
    writeFileSync(path, original.replace(mutation.before, mutation.after));
    const result = spawnSync("bun", ["run", "test", test, "-t", mutation.pattern], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    const output = result.stdout + result.stderr;
    process.stdout.write(`\n${mutation.name}\n${output}`);
    if (result.status !== 1 || !output.includes("AssertionError"))
      throw new Error(`Expected an assertion failure for: ${mutation.name}`);
  } finally {
    writeFileSync(path, original);
  }
}
process.stdout.write("\nAll four mutations caught; runtime restored.\n");
