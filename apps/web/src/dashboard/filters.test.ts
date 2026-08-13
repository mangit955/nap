import type { ProjectSummaryPayload } from "@nap/shared/projects-protocol";
import { describe, expect, it } from "vitest";
import {
  filterProjects,
  greetingName,
  recentProjects,
  scopeCounts,
  tileGradient,
} from "./filters.ts";

/**
 * The dashboard's arithmetic: which projects the grid shows, which ones the sidebar lists, and
 * what to call the person looking at it. All of it is pure, so it is a `.test.ts` running in
 * Node — there is nothing here that needs a DOM.
 */

function project(over: Partial<ProjectSummaryPayload> = {}): ProjectSummaryPayload {
  return {
    projectId: "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192",
    name: "Habit Builder",
    status: "ready",
    sandboxId: "sbx_1",
    updatedAt: "2026-08-12T10:00:00.000Z",
    sessionIds: [],
    ...over,
  };
}

const running = project({ projectId: "a", name: "Habit Builder", sandboxId: "sbx_1" });
const putAway = project({
  projectId: "b",
  name: "Todo Landing Page",
  sandboxId: null,
  status: "idle",
});
const brandNew = project({ projectId: "c", name: "Untitled", sandboxId: null, status: "creating" });

describe("filtering the grid", () => {
  it("shows everything under All", () => {
    const shown = filterProjects([running, putAway, brandNew], { query: "", scope: "all" });

    expect(shown.map((p) => p.projectId)).toEqual(["a", "b", "c"]);
  });

  it("splits on whether a sandbox is actually serving the project", () => {
    // `projectState` calls the second one "put away" and the third "new", but neither is
    // running — and "which of these can I open right now" is the question the scope answers.
    expect(
      filterProjects([running, putAway, brandNew], { query: "", scope: "running" }).map(
        (p) => p.projectId,
      ),
    ).toEqual(["a"]);
    expect(
      filterProjects([running, putAway, brandNew], { query: "", scope: "put-away" }).map(
        (p) => p.projectId,
      ),
    ).toEqual(["b", "c"]);
  });

  it("matches a name however it was typed, and ignores the spaces around it", () => {
    const shown = filterProjects([running, putAway], { query: "  hAbIt ", scope: "all" });

    expect(shown.map((p) => p.projectId)).toEqual(["a"]);
  });

  it("searches within the scope rather than across it", () => {
    // Otherwise a search would quietly undo the scope the sidebar says is selected.
    expect(filterProjects([running, putAway], { query: "habit", scope: "put-away" })).toEqual([]);
  });

  it("counts every scope, and the two halves add up to the whole", () => {
    const counts = scopeCounts([running, putAway, brandNew]);

    expect(counts).toEqual({ all: 3, running: 1, "put-away": 2 });
  });
});

describe("the recents list", () => {
  it("is the most recently touched first, however the server ordered them", () => {
    const older = project({ projectId: "old", updatedAt: "2026-08-01T10:00:00.000Z" });
    const newer = project({ projectId: "new", updatedAt: "2026-08-12T10:00:00.000Z" });

    expect(recentProjects([older, newer], 5).map((p) => p.projectId)).toEqual(["new", "old"]);
  });

  it("stops at the limit, because a sidebar is not a list of everything", () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      project({ projectId: `p${index}`, updatedAt: `2026-08-0${index + 1}T10:00:00.000Z` }),
    );

    expect(recentProjects(many, 5)).toHaveLength(5);
  });

  it("leaves the list it was given alone", () => {
    // It sorts, and an in-place sort here would reorder the grid as a side effect of drawing
    // the sidebar — which reads as the grid shuffling itself for no reason.
    const given = [project({ projectId: "old", updatedAt: "2026-08-01T10:00:00.000Z" }), running];
    recentProjects(given, 5);

    expect(given.map((p) => p.projectId)).toEqual(["old", "a"]);
  });
});

describe("what to call the person signed in", () => {
  it("uses the first word of their name", () => {
    expect(greetingName({ name: "Manas Raghuwanshi", email: "m@example.com" })).toBe("Manas");
  });

  it("falls back to the part of the email before the at sign", () => {
    expect(greetingName({ name: "", email: "ada@example.com" })).toBe("ada");
  });

  it("has something to say when it knows nothing at all", () => {
    // The greeting is the first line on the page; it cannot render "Let's build something, ,".
    expect(greetingName(undefined)).toBe("there");
  });
});

describe("a project's tile", () => {
  it("is the same every visit", () => {
    // The tile stands in for a screenshot. One that changed on each render would read as the
    // page failing to remember which project is which.
    expect(tileGradient("a")).toBe(tileGradient("a"));
  });

  it("differs between projects", () => {
    expect(tileGradient("a")).not.toBe(tileGradient("b"));
  });

  it("is a gradient a browser will accept", () => {
    expect(tileGradient("3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192")).toMatch(
      /^linear-gradient\(135deg, hsl\([\d.]+ \d+% \d+%\), hsl\([\d.]+ \d+% \d+%\)\)$/,
    );
  });
});
