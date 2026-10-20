import { describe, expect, it } from "vitest";
import { SessionStartSchema } from "./session-start-protocol.ts";

describe("new session requests", () => {
  const operationId = "00000000-0000-4000-8000-000000000001";
  it("requires a task for templates but allows a repository-only workspace", () => {
    expect(
      SessionStartSchema.safeParse({ operationId, source: { kind: "template" } }).success,
    ).toBe(false);
    expect(
      SessionStartSchema.safeParse({
        operationId,
        source: {
          kind: "github",
          installationId: 1,
          repositoryId: 2,
          baseBranch: "main",
          name: "Example",
          environment: {},
          autoPublish: false,
        },
      }).success,
    ).toBe(true);
  });
  it("requires a stable operation identity and validates source settings", () => {
    expect(
      SessionStartSchema.safeParse({
        source: { kind: "template" },
        prompt: { message: "Build a page" },
      }).success,
    ).toBe(false);
    expect(
      SessionStartSchema.safeParse({
        operationId,
        source: { kind: "template" },
        prompt: { message: "  Build a page  " },
      }).data?.prompt?.message,
    ).toBe("Build a page");
    expect(
      SessionStartSchema.safeParse({
        operationId,
        source: {
          kind: "github",
          installationId: 1,
          repositoryId: 2,
          baseBranch: "--invalid",
          name: "Example",
          environment: {},
        },
      }).success,
    ).toBe(false);
  });
});
