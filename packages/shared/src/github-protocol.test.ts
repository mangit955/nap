import { describe, expect, it } from "vitest";
import { GitRefSchema, RepositoryEnvironmentSchema } from "./github-protocol.ts";

describe("repository input boundaries", () => {
  it.each([
    "-upload-pack=evil",
    "../main",
    "refs/heads/main",
    "a.lock/b",
    "main\n",
    "a@{b",
    "a//b",
  ])("rejects unsafe ref %j", (ref) => {
    expect(GitRefSchema.safeParse(ref).success).toBe(false);
  });
  it("accepts branch names and requires a complete preview configuration", () => {
    expect(GitRefSchema.parse("feature/github-app")).toBe("feature/github-app");
    expect(
      RepositoryEnvironmentSchema.safeParse({ devCommand: "bun run dev", previewPort: null })
        .success,
    ).toBe(false);
    expect(
      RepositoryEnvironmentSchema.parse({
        setupCommand: null,
        devCommand: null,
        previewPort: null,
      }),
    ).toEqual({ setupCommand: null, devCommand: null, previewPort: null });
  });
});
