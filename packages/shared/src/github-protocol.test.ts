import { describe, expect, it } from "vitest";
import {
  GitRefSchema,
  isJobBranch,
  jobBranch,
  RepositoryEnvironmentSchema,
} from "./github-protocol.ts";

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

describe("a job's branch", () => {
  it("is named from the job's id, and recognised as one Nap made", () => {
    const branch = jobBranch("7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5");
    expect(branch).toBe("nap/7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5");
    expect(isJobBranch(branch)).toBe(true);
  });

  it("is not any branch under nap/, which people name theirs too", () => {
    expect(isJobBranch("nap/fix-header")).toBe(false);
    expect(isJobBranch("nap/7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5-retry")).toBe(false);
    expect(isJobBranch("feat/7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5")).toBe(false);
    expect(isJobBranch("feat/pricing-table-with-annual-toggle")).toBe(false);
  });
});
