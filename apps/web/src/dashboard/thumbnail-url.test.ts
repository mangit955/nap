import { describe, expect, it } from "vitest";
import { thumbnailUrl } from "./thumbnail-url.ts";

describe("a project's thumbnail address", () => {
  it("points at the project's own picture", () => {
    expect(thumbnailUrl("p1", "2026-08-09T11:00:00.000Z", "https://api.example")).toMatch(
      "https://api.example/projects/p1/thumbnail",
    );
  });

  it("changes when the project does", () => {
    // The bytes at that key are replaced by every turn that changes the project, so an address
    // that stayed the same would let a browser show yesterday's app for as long as it liked.
    const before = thumbnailUrl("p1", "2026-08-09T11:00:00.000Z", "https://api.example");
    const after = thumbnailUrl("p1", "2026-08-09T12:30:00.000Z", "https://api.example");

    expect(after).not.toBe(before);
  });

  it("escapes the version, so a timestamp cannot become another parameter", () => {
    expect(thumbnailUrl("p1", "2026-08-09T11:00:00.000Z", "https://api.example")).toContain(
      "v=2026-08-09T11%3A00%3A00.000Z",
    );
  });
});
