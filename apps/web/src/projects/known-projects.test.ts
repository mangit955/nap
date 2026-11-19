import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetKnownProject,
  forgetKnownProjects,
  knownProject,
  knownProjectsEpoch,
  rememberProjects,
} from "./known-projects.ts";

const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const record = (name: string) => ({
  projectId: PROJECT,
  name,
  status: "ready" as const,
  sandboxId: null,
  updatedAt: "2026-08-09T12:30:00.000Z",
  sessionIds: ["5509bb3b-712e-4190-bc00-ed964702c8d1"],
});

beforeEach(forgetKnownProjects);

describe("the project records a tab holds", () => {
  it("holds the newest record put in for a project", () => {
    rememberProjects([record("First")]);
    rememberProjects([record("Second")]);
    expect(knownProject(PROJECT)?.name).toBe("Second");
  });

  it("keeps only a project record's fields from a session row", () => {
    rememberProjects([{ ...record("Row"), activity: "working", navigation: {} } as never]);
    expect(knownProject(PROJECT)).toEqual(record("Row"));
  });

  it("drops a list asked for before a sign-out and answered after it", () => {
    const askedAt = knownProjectsEpoch();
    forgetKnownProjects();
    rememberProjects([record("The last person's")], askedAt);
    expect(knownProject(PROJECT)).toBeUndefined();
  });

  it("forgets a deleted project", () => {
    rememberProjects([record("Gone")]);
    forgetKnownProject(PROJECT);
    expect(knownProject(PROJECT)).toBeUndefined();
  });

  it("is bounded, oldest out first", () => {
    const many = Array.from({ length: 205 }, (_, i) => ({
      ...record(`P${i}`),
      projectId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    }));
    rememberProjects(many);
    expect(knownProject(many[0]?.projectId ?? "")).toBeUndefined();
    expect(knownProject(many[204]?.projectId ?? "")?.name).toBe("P204");
  });
});
