import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Changelog } from "./changelog.tsx";
import { REPO_URL } from "./github-button.tsx";

describe("the changelog strip", () => {
  it("links each entry to the pull request that made it, newest first", () => {
    render(<Changelog />);
    const entries = screen.getAllByRole("listitem");
    expect(entries).toHaveLength(4);
    const dates = entries.map((entry) => entry.querySelector("time")?.getAttribute("dateTime"));
    expect(dates).toEqual([...dates].sort().reverse());
    for (const entry of entries) {
      expect(entry.querySelector("a")?.getAttribute("href")).toMatch(
        new RegExp(`^${REPO_URL}/pull/\\d+$`),
      );
    }
  });

  it("shows the day it shipped, even west of Greenwich", async () => {
    // A bare date is midnight UTC, which is the evening before anywhere with a negative offset.
    // The suite runs in UTC on CI and east of it locally, so the zone is pinned here; `DAY` is
    // built when the module loads, hence the fresh import.
    const zone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      vi.resetModules();
      const { Changelog: Fresh } = await import("./changelog.tsx");
      render(<Fresh />);
      expect(screen.getByText("Nov 21, 2026")).toHaveAttribute("dateTime", "2026-11-21");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});
