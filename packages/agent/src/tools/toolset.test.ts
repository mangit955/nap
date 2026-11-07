import { TOOL_NAMES } from "@nap/shared/events";
import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "./definitions.ts";
import { modelFamily, type ToolsetOptions, toolNamesFor, toolsetFor } from "./toolset.ts";

const USER: ToolsetOptions = {
  promptSource: "user",
  family: "gpt",
  computer: true,
  subagents: true,
};

function names(options: ToolsetOptions): string[] {
  return [...toolNamesFor(options)].toSorted();
}

describe("modelFamily", () => {
  it.each([
    ["openai/gpt-5.6-luna", "gpt"],
    ["anthropic/claude-opus-5", "claude"],
    ["claude-sonnet-5", "claude"],
    [undefined, "claude"],
    ["mistral/whatever", "claude"],
  ] as const)("%s is %s", (model, family) => {
    expect(modelFamily(model)).toBe(family);
  });
});

describe("toolNamesFor", () => {
  it("offers a person's own turn everything but the plan proposal, when everything is wired", () => {
    expect(names(USER)).toEqual(TOOL_NAMES.filter((name) => name !== "propose_plan").toSorted());
  });

  it("offers a plan mode turn looking, asking and proposing, and nothing that edits", () => {
    expect(names({ ...USER, mode: "plan" })).toEqual([
      "ask_user",
      "glob",
      "list_files",
      "propose_plan",
      "read_file",
      "read_subagent",
      "run_subagent",
      "search_files",
      "shell_output",
      "skill",
    ]);
  });

  it("offers skills to every turn a person or a check started, whether or not the project has any", () => {
    // Offered even to a project with none, so a first skill added mid-session does not change
    // the declared tools — the head of every cached prefix (ADR-0024, ADR-0029).
    for (const promptSource of ["user", "verification"] as const)
      expect(toolNamesFor({ ...USER, promptSource }).has("skill")).toBe(true);
  });

  it("offers skills to neither a helper nor an app test", () => {
    expect(toolNamesFor({ ...USER, subagent: "explore" }).has("skill")).toBe(false);
    expect(toolNamesFor({ ...USER, subagent: "general" }).has("skill")).toBe(false);
    expect(toolNamesFor({ ...USER, promptSource: "test" }).has("skill")).toBe(false);
  });

  it("keeps a plan mode turn read-only on every model family and without the computer", () => {
    const offered = toolNamesFor({ ...USER, family: "claude", mode: "plan" });
    for (const name of [
      "run_command",
      "write_file",
      "edit_file",
      "apply_patch",
      "shell_input",
      "shell_kill",
      "todo_write",
      "computer",
    ] as const)
      expect(offered.has(name)).toBe(false);
  });

  it("offers the plan proposal only in plan mode, never to a helper", () => {
    expect(toolNamesFor({ ...USER, promptSource: "verification" }).has("propose_plan")).toBe(false);
    expect(toolNamesFor({ ...USER, mode: "plan", subagent: "explore" }).has("propose_plan")).toBe(
      false,
    );
  });

  it("keeps the patch format for the models trained on it", () => {
    expect(toolNamesFor({ ...USER, family: "claude" }).has("apply_patch")).toBe(false);
    expect(toolNamesFor({ ...USER, family: "claude" }).has("edit_file")).toBe(true);
  });

  it("offers neither the computer nor helpers when they are not wired", () => {
    const offered = toolNamesFor({ ...USER, computer: false, subagents: false });
    for (const name of ["computer", "run_subagent", "read_subagent"] as const)
      expect(offered.has(name)).toBe(false);
  });

  it("never asks a question nobody is there to answer", () => {
    expect(toolNamesFor({ ...USER, promptSource: "verification" }).has("ask_user")).toBe(false);
    expect(toolNamesFor({ ...USER, promptSource: "verification" }).has("write_file")).toBe(true);
  });

  it("declares on a repair turn exactly what a person's turn declares, so the cache survives it", () => {
    // Offered and declared differ by `ask_user` alone: the executor refuses it on a repair.
    const repair = { ...USER, promptSource: "verification" as const };
    expect(JSON.stringify(toolsetFor(repair))).toBe(JSON.stringify(toolsetFor(USER)));
    expect(toolNamesFor(repair).has("ask_user")).toBe(false);
  });

  it("lets an app test look but not touch", () => {
    expect(names({ ...USER, promptSource: "test" })).toEqual([
      "computer",
      "glob",
      "list_files",
      "read_file",
      "search_files",
    ]);
  });

  it("gives an explore helper only reading and searching", () => {
    expect(names({ ...USER, subagent: "explore" })).toEqual([
      "glob",
      "list_files",
      "read_file",
      "search_files",
    ]);
  });

  it("gives a general helper writing and commands, but nothing that talks or delegates", () => {
    expect(names({ ...USER, subagent: "general" })).toEqual([
      "apply_patch",
      "edit_file",
      "glob",
      "list_files",
      "read_file",
      "run_command",
      "search_files",
      "write_file",
    ]);
  });
});

describe("toolsetFor", () => {
  it("keeps the registry's order whatever the rules removed, so the cached prefix is stable", () => {
    const order = TOOL_DEFINITIONS.map((tool) => tool.name);
    const offered = toolsetFor({ ...USER, family: "claude", computer: false }).map(
      (tool) => tool.name,
    );
    expect(offered).toEqual(order.filter((name) => offered.includes(name)));
  });
});
