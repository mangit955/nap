import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { describe, expect, it } from "vitest";
import { parseBenchTask } from "../task.ts";
import { TRACER_TASK } from "./tracer.ts";

describe("the tracer task", () => {
  it("is valid, which importing it has already proved", () => {
    // `defineTask` throws at import, so this file failing to load *is* the assertion. Stated
    // again here so the guarantee is visible rather than a side effect of a module loading.
    expect(parseBenchTask(TRACER_TASK).ok).toBe(true);
  });

  it("runs its check inside the project, not in the home directory", () => {
    // `bun run build` in the wrong directory fails on a missing package.json, which would
    // look exactly like an agent that broke the build.
    expect(TRACER_TASK.checks[0]?.command).toContain(PROJECT_ROOT_PATH);
  });
});

describe("defineTask", () => {
  it("throws on a malformed task rather than returning one", async () => {
    // A task file is source, so a bad one is a bug — and it must surface at import, before
    // a run id, a sandbox or a model call exists.
    const { defineTask } = await import("../task.ts");
    expect(() => defineTask({ ...TRACER_TASK, checks: [] })).toThrow(/invalid task/);
  });
});
