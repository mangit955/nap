/**
 * What verification finds in a project that has just been created and nothing else.
 *
 * Every project starts as a copy of `packages/sandbox/template`, so its `package.json` is the
 * one input discovery is guaranteed to meet — and the case where getting it wrong is worst:
 * a check reported as failed on a brand-new project opens a repair loop before the user has
 * asked for anything. The template declares no `test` script, and that has to stay *absent*.
 *
 * `typecheck` is the opposite case, and the one this file exists to hold. Vite does not
 * typecheck, so a project whose only runnable check is `build` can be reported *verified* while
 * `tsc --noEmit` rejects it — which is exactly what three funded runs recorded before the
 * template declared the script. See `docs/napbench-verification-measurement.md`. Discovery
 * reads scripts and only scripts, so the guard against that regression lives here, where the
 * template's own manifest is the input.
 *
 * Read from disk rather than copied into the test, because the template is edited by whoever
 * changes the starter app and nothing else would notice. A template that gains a `test`
 * script fails here, which is the moment to check the command it produces terminates.
 */

import { readFileSync } from "node:fs";
import { discoverChecks } from "@nap/verify/discover-checks";
import { describe, expect, it } from "vitest";

const TEMPLATE_PACKAGE_JSON = readFileSync(
  new URL("../packages/sandbox/template/package.json", import.meta.url),
  "utf8",
);

describe("a freshly created project", () => {
  it("can be typechecked and built, and is not asked for lint or tests", () => {
    expect(discoverChecks(TEMPLATE_PACKAGE_JSON)).toEqual([
      { name: "typecheck", state: "runnable", command: "cd /home/user/app && bun run typecheck" },
      { name: "lint", state: "absent" },
      { name: "build", state: "runnable", command: "cd /home/user/app && bun run build" },
      { name: "test", state: "absent" },
    ]);
  });
});
