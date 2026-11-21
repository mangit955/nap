import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

  it("shows the day it shipped, whatever the visitor's time zone", () => {
    render(<Changelog />);
    expect(screen.getByText("Nov 21, 2026")).toHaveAttribute("dateTime", "2026-11-21");
  });
});
