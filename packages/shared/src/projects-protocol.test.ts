import { describe, expect, it } from "vitest";
import {
  ProjectListSchema,
  type ProjectSummaryPayload,
  ProjectSummarySchema,
  projectState,
} from "./projects-protocol.ts";

const VALID: ProjectSummaryPayload = {
  projectId: "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192",
  name: "Todo app",
  status: "ready",
  sandboxId: "sbx_live",
  updatedAt: "2026-08-09T11:00:00.000Z",
  sessionIds: ["2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77"],
};

describe("the summary schema", () => {
  it("accepts what the endpoint sends", () => {
    expect(ProjectSummarySchema.safeParse(VALID).success).toBe(true);
  });

  it("accepts a project with no sandbox and no sessions", () => {
    // Both are ordinary: a project put away has no sandbox, and one nobody has talked in has
    // no session. A schema that refused either would blank the list page over a normal row.
    const parsed = ProjectSummarySchema.safeParse({ ...VALID, sandboxId: null, sessionIds: [] });

    expect(parsed.success).toBe(true);
  });

  it("refuses a timestamp that is not a timestamp", () => {
    const parsed = ProjectSummarySchema.safeParse({ ...VALID, updatedAt: "yesterday" });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.path).toEqual(["updatedAt"]);
  });

  it("refuses an unknown key rather than dropping it", () => {
    // Strict, like the event payloads: a field the server started sending and the client
    // silently ignores is a contract change nobody notices.
    expect(ProjectSummarySchema.safeParse({ ...VALID, secret: true }).success).toBe(false);
  });

  it("parses a whole listing", () => {
    expect(ProjectListSchema.safeParse({ projects: [VALID] }).success).toBe(true);
  });
});

describe("what state a project is in", () => {
  it("is running while it holds a sandbox", () => {
    expect(projectState(VALID)).toBe("running");
  });

  it("is running even if the row says otherwise", () => {
    // The sandbox is the fact; the column is whatever the last writer put there. Trusting the
    // column would show "put away" next to a project that is serving a preview right now.
    expect(projectState({ ...VALID, status: "idle" })).toBe("running");
  });

  it("is put away once the sandbox is gone", () => {
    expect(projectState({ ...VALID, sandboxId: null, status: "idle" })).toBe("put away");
  });

  it("is new when it has never had one", () => {
    expect(projectState({ ...VALID, sandboxId: null, status: "creating" })).toBe("new");
  });
});
