import { describe, expect, it } from "vitest";
import { projectIdOf } from "./open-project.ts";

describe("projectIdOf", () => {
  it("reads the project a workspace address names", () => {
    expect(projectIdOf("/p/3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192")).toBe(
      "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192",
    );
    expect(projectIdOf("/p/abc/")).toBe("abc");
    expect(projectIdOf("/p/a%20b")).toBe("a b");
  });

  it("names no project for any other address", () => {
    expect(projectIdOf("/dashboard")).toBeUndefined();
    expect(projectIdOf("/p")).toBeUndefined();
    expect(projectIdOf("/p/")).toBeUndefined();
    expect(projectIdOf("/p/abc/settings")).toBeUndefined();
    expect(projectIdOf(null)).toBeUndefined();
    // The workspace before it knows its project, not a project called "new".
    expect(projectIdOf("/p/new")).toBeUndefined();
  });

  it("names no project for a malformed escape rather than throwing", () => {
    expect(projectIdOf("/p/%E0%A4%A")).toBeUndefined();
  });
});
