import { TOOL_NAMES } from "@nap/shared/events";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, TOOL_DEFINITIONS, TOOL_SCHEMAS } from "./definitions.ts";

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
  // Structural rather than a hardcoded list: adding a seventh tool to the event union
  // fails here until it is given a definition, which is the point.
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
  ] as const)("%s requires %j", (name, required) => {
    expect(schemaFor(name).required?.toSorted()).toEqual([...required].toSorted());
  });

  it("offers search_files an optional path", () => {
    const schema = schemaFor("search_files");
    expect(Object.keys(schema.properties).toSorted()).toEqual(["path", "pattern"]);
    expect(schema.required).not.toContain("path");
  });

  it("does not leak the $schema dialect marker into the tool schema", () => {
    // Not an error, but it is noise on every request of every turn, and it is the kind
    // of key that quietly becomes a compatibility problem.
    for (const definition of TOOL_DEFINITIONS) {
      expect(definition.inputSchema).not.toHaveProperty("$schema");
    }
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
