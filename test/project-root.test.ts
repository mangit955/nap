/**
 * Three packages state where a project lives inside its sandbox, and they must agree.
 *
 * Each copy exists for a reason. `@nap/sandbox` states it as part of the template contract —
 * it is the working directory the image builds into. `@nap/agent` states it because it is
 * what the model is told, and that package may not depend on the sandbox one. `@nap/shared`
 * states it because a browser needs it to match an event's absolute path against a listing,
 * and importing either of the others into a client bundle would be worse than a constant.
 *
 * Nothing at runtime notices when they drift: the agent would write files somewhere the tree
 * never lists, and every changed file would silently stop being highlighted.
 */

import { PROJECT_ROOT } from "@nap/agent/tools/definitions";
import { SYSTEM_PROMPT } from "@nap/context/system-prompt";
import { TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { describe, expect, it } from "vitest";

describe("the project root", () => {
  it("is the same string everywhere it is stated", () => {
    expect(PROJECT_ROOT).toBe(TEMPLATE_WORKDIR);
    expect(PROJECT_ROOT_PATH).toBe(TEMPLATE_WORKDIR);
  });

  it("is what the model is told", () => {
    expect(SYSTEM_PROMPT).toContain(TEMPLATE_WORKDIR);
  });
});
