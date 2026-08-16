/**
 * What verification finds in a project that has just been created and nothing else.
 *
 * Every project starts as a copy of `packages/sandbox/template`, so its `package.json` is the
 * one input discovery is guaranteed to meet — and the case where getting it wrong is worst:
 * a check reported as failed on a brand-new project opens a repair loop before the user has
 * asked for anything. The template declares no `test` script, and that has to stay *absent*.
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
  it("has a build check and nothing else", () => {
    expect(discoverChecks(TEMPLATE_PACKAGE_JSON)).toEqual([
      { name: "typecheck", state: "absent" },
      { name: "lint", state: "absent" },
      { name: "build", state: "runnable", command: "cd /home/user/app && bun run build" },
      { name: "test", state: "absent" },
    ]);
  });
});
