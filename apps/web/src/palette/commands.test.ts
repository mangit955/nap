import { describe, expect, it } from "vitest";
import { type Command, groupCommands, stepIndex } from "./commands.ts";

const command = (id: string, group: Command["group"], order: number, label = id): Command => ({
  id,
  group,
  order,
  label,
  icon: null,
  run: () => {},
});

describe("groupCommands", () => {
  const all = [
    command("browser", "Actions", 3, "Open Browser"),
    command("fix", "Sessions", 100, "Fix the file picker"),
    command("files", "Actions", 2, "Open Files"),
    command("new", "Actions", 0, "New session"),
    command("changes", "Actions", 4, "Show changed files"),
  ];

  it("puts actions before sessions, each in its own order, whatever order they registered in", () => {
    expect(
      groupCommands(all, "").map((group) => [group.name, group.commands.map((c) => c.id)]),
    ).toEqual([
      ["Actions", ["new", "files", "browser", "changes"]],
      ["Sessions", ["fix"]],
    ]);
  });

  it("keeps what contains the query, ignoring case and surrounding space", () => {
    expect(groupCommands(all, "  FILE ").map((group) => group.commands.map((c) => c.id))).toEqual([
      ["files", "changes"],
      ["fix"],
    ]);
  });

  it("drops a group with nothing left in it", () => {
    expect(groupCommands(all, "browser").map((group) => group.name)).toEqual(["Actions"]);
    expect(groupCommands(all, "nothing like this")).toEqual([]);
  });
});

describe("stepIndex", () => {
  it("wraps at both ends", () => {
    expect(stepIndex(0, 1, 3)).toBe(1);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
  });

  it("stays at nothing when there is nothing", () => {
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
});
