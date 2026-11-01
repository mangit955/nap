import { TOOL_NAMES } from "@nap/shared/events";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, runsConcurrently, TOOL_DEFINITIONS, TOOL_SCHEMAS } from "./definitions.ts";

/** The JSON Schema shape the model is handed, narrowed enough to assert on. */
type ObjectSchema = {
  type: string;
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

function schemaFor(name: string): ObjectSchema {
  const definition = TOOL_DEFINITIONS.find((d) => d.name === name);
  if (definition === undefined) throw new Error(`no definition for ${name}`);
  return definition.inputSchema as unknown as ObjectSchema;
}

describe("TOOL_DEFINITIONS", () => {
  // Structural rather than a hardcoded list: adding a tool to the event union fails here
  // until it is given a definition, which is the point.
  it("covers exactly the tool names the event log accepts", () => {
    expect(TOOL_DEFINITIONS.map((d) => d.name).toSorted()).toEqual([...TOOL_NAMES].toSorted());
  });

  it("has a schema for every name", () => {
    expect(Object.keys(TOOL_SCHEMAS).toSorted()).toEqual([...TOOL_NAMES].toSorted());
  });

  it.each([...TOOL_NAMES])("%s describes when to reach for it, not just what it is", (name) => {
    const definition = TOOL_DEFINITIONS.find((d) => d.name === name);
    // A description that only names the tool gives the model nothing to trigger on.
    expect(definition?.description.length).toBeGreaterThan(40);
  });

  it.each([...TOOL_NAMES])("%s is an object schema that rejects unknown keys", (name) => {
    const schema = schemaFor(name);
    expect(schema.type).toBe("object");
    // Without this the model can invent arguments and they arrive silently ignored.
    expect(schema.additionalProperties).toBe(false);
  });

  it.each([
    ["read_file", ["path"]],
    ["write_file", ["path", "contents"]],
    ["edit_file", ["path", "old_string", "new_string"]],
    ["list_files", ["path"]],
    ["search_files", ["pattern"]],
    ["run_command", ["command"]],
    ["apply_patch", ["patch"]],
    ["glob", ["pattern"]],
    ["shell_output", ["shell_id"]],
    ["shell_input", ["shell_id", "text"]],
    ["shell_kill", ["shell_id"]],
    ["todo_write", ["todos"]],
    ["ask_user", ["question", "options", "multiSelect"]],
    ["run_subagent", ["profile", "task"]],
    ["read_subagent", ["subagent_id"]],
  ] as const)("%s requires %j", (name, required) => {
    expect(schemaFor(name).required?.toSorted()).toEqual([...required].toSorted());
  });

  it("offers search_files an optional path and filters", () => {
    const schema = schemaFor("search_files");
    expect(Object.keys(schema.properties).toSorted()).toEqual([
      "files_only",
      "glob",
      "ignore_case",
      "path",
      "pattern",
    ]);
    expect(schema.required).toEqual(["pattern"]);
  });

  it("describes the patch format in apply_patch's own description", () => {
    // The format is the contract, and GPT models are trained on it by these exact markers.
    const description = TOOL_DEFINITIONS.find((tool) => tool.name === "apply_patch")?.description;
    for (const marker of ["*** Begin Patch", "*** Update File:", "*** End Patch", "@@"])
      expect(description).toContain(marker);
  });

  it("does not leak the $schema dialect marker into the tool schema", () => {
    // Not an error, but it is noise on every request of every turn, and it is the kind
    // of key that quietly becomes a compatibility problem.
    for (const definition of TOOL_DEFINITIONS) {
      expect(definition.inputSchema).not.toHaveProperty("$schema");
    }
  });
});

describe("runsConcurrently", () => {
  it.each([
    ["read_file", {}, true],
    ["list_files", {}, true],
    ["glob", {}, true],
    ["search_files", {}, true],
    ["write_file", {}, false],
    ["edit_file", {}, false],
    ["apply_patch", {}, false],
    ["run_command", {}, false],
    ["shell_output", {}, false],
    ["todo_write", {}, false],
    ["ask_user", {}, false],
    ["computer", {}, false],
    ["run_subagent", { profile: "explore" }, true],
    ["run_subagent", { profile: "general" }, false],
    ["run_subagent", { profile: "explore", background: true }, false],
    ["not_a_tool", {}, false],
  ] as const)("%s %j runs concurrently: %s", (name, input, expected) => {
    expect(runsConcurrently(name, input)).toBe(expected);
  });
});

describe("TOOL_SCHEMAS", () => {
  it("rejects an unknown argument", () => {
    expect(TOOL_SCHEMAS.read_file.safeParse({ path: "/a", mode: "r" }).success).toBe(false);
  });

  it("rejects an empty path", () => {
    expect(TOOL_SCHEMAS.read_file.safeParse({ path: "" }).success).toBe(false);
  });

  it("accepts an empty string as new file contents", () => {
    // Emptying a file is a legitimate edit; only the path has to be non-empty.
    expect(TOOL_SCHEMAS.write_file.safeParse({ path: "/a", contents: "" }).success).toBe(true);
  });
});

describe("PROJECT_ROOT", () => {
  it("matches the directory the sandbox template builds the app in", () => {
    expect(PROJECT_ROOT).toBe("/home/user/app");
  });
});
