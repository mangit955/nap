import { describe, expect, it } from "vitest";
import { isUnnamed, titleFromPrompt, UNTITLED_PROJECT } from "./project-title.ts";

/**
 * Turning the first thing somebody asked for into a name for the project.
 *
 * The cases below are the whole specification. Each one is a shape of prompt people actually
 * type, and the assertion is what a person would want to see in a grid of projects a week later
 * — never the prompt back verbatim, and never "Untitled project" when the prompt said something.
 */

describe("the request wrapped around the thing", () => {
  it("drops a leading instruction", () => {
    expect(titleFromPrompt("Build a small to-do app")).toBe("Small To-do App");
  });

  it("drops it however it was phrased", () => {
    // These are the openings that turn up over and over, and every one of them is noise: a grid
    // of projects all beginning "Make A…" sorts badly and reads worse.
    expect(titleFromPrompt("create a pomodoro timer")).toBe("Pomodoro Timer");
    expect(titleFromPrompt("make me a habit tracker")).toBe("Habit Tracker");
    expect(titleFromPrompt("I want a recipe box")).toBe("Recipe Box");
    expect(titleFromPrompt("can you build a budget planner")).toBe("Budget Planner");
    expect(titleFromPrompt("please make an expense tracker")).toBe("Expense Tracker");
  });

  it("ignores the case it was typed in", () => {
    expect(titleFromPrompt("BUILD ME A markdown editor")).toBe("Markdown Editor");
  });

  it("strips only one opening, so the subject survives", () => {
    // "Build a build log" must not lose the word it is about.
    expect(titleFromPrompt("build a build log")).toBe("Build Log");
  });

  it("leaves a prompt that is already a subject alone", () => {
    expect(titleFromPrompt("kanban board")).toBe("Kanban Board");
  });
});

describe("cutting it down to the subject", () => {
  it("stops at the end of the first sentence", () => {
    expect(titleFromPrompt("Build a to-do app. It should sync.")).toBe("To-do App");
  });

  it("stops at the first clause break", () => {
    expect(titleFromPrompt("a pomodoro timer with a circular countdown")).toBe("Pomodoro Timer");
    expect(titleFromPrompt("a habit tracker, dark theme please")).toBe("Habit Tracker");
    expect(titleFromPrompt("a notes app that saves to local storage")).toBe("Notes App");
    expect(titleFromPrompt("a dashboard where I can see my spending")).toBe("Dashboard");
  });

  it("drops a trailing courtesy", () => {
    expect(titleFromPrompt("Build a small to-do app for me.")).toBe("Small To-do App");
  });

  it("drops trailing punctuation", () => {
    expect(titleFromPrompt("a colour palette generator!")).toBe("Colour Palette Generator");
  });

  it("collapses the whitespace somebody pasted in", () => {
    expect(titleFromPrompt("  a   habit\n\ntracker  ")).toBe("Habit Tracker");
  });
});

describe("how long it is allowed to be", () => {
  it("caps a rambling prompt", () => {
    const title = titleFromPrompt(
      "an application for tracking every single one of the books that I have ever read",
    );

    expect(title.length).toBeLessThanOrEqual(40);
  });

  it("cuts on a word boundary rather than mid-word", () => {
    // A name ending "…tracking ever" reads as a typo rather than as an abbreviation.
    const title = titleFromPrompt(
      "an application for tracking every single one of the books that I have ever read",
    );

    expect(title).not.toMatch(/\s$/);
    expect(`${title} `).toContain(" ");
    // Whatever it cut at, the last word is a whole one from the prompt.
    const last = title.split(" ").at(-1) ?? "";
    expect(
      "an application for tracking every single one of the books that I have ever read".toLowerCase(),
    ).toContain(last.toLowerCase());
  });

  it("leaves a short prompt uncut", () => {
    expect(titleFromPrompt("a timer")).toBe("Timer");
  });
});

describe("capitalisation", () => {
  it("title-cases ordinary words", () => {
    expect(titleFromPrompt("a recipe box")).toBe("Recipe Box");
  });

  it("keeps a word that already carries its own capitals", () => {
    // Re-casing these is worse than leaving them: "Ios" and "Github" read as mistakes, and the
    // person who typed them knew what they meant.
    expect(titleFromPrompt("an iOS settings screen")).toBe("iOS Settings Screen");
    expect(titleFromPrompt("a GitHub profile viewer")).toBe("GitHub Profile Viewer");
  });

  it("leaves small joining words lowercase inside the name", () => {
    expect(titleFromPrompt("a wheel of fortune")).toBe("Wheel of Fortune");
  });

  it("capitalises the first word even when it is a small one", () => {
    expect(titleFromPrompt("the quick brown fox")).toBe("Quick Brown Fox");
  });
});

describe("when there is nothing to work with", () => {
  /*
   * The important half of this. `ProjectSummarySchema` requires a name of at least one
   * character, so an empty title would not fail here — it would fail at the far end, where it
   * reads as a corrupt record rather than as a strange prompt.
   */
  it("falls back for an empty prompt", () => {
    expect(titleFromPrompt("")).toBe(UNTITLED_PROJECT);
  });

  it("falls back for whitespace", () => {
    expect(titleFromPrompt("   \n  ")).toBe(UNTITLED_PROJECT);
  });

  it("falls back for punctuation alone", () => {
    expect(titleFromPrompt("!!! ???")).toBe(UNTITLED_PROJECT);
  });

  it("falls back when the prompt is nothing but an opening", () => {
    // "build me a" has a subject of exactly nothing.
    expect(titleFromPrompt("build me a")).toBe(UNTITLED_PROJECT);
  });

  it("never answers with an empty string", () => {
    for (const prompt of ["", " ", ".", "a", "the", "please", "...", "a."]) {
      expect(titleFromPrompt(prompt).length).toBeGreaterThan(0);
    }
  });
});

describe("telling an unnamed project from a named one", () => {
  it("recognises the default", () => {
    expect(isUnnamed(UNTITLED_PROJECT)).toBe(true);
  });

  it("ignores the case and padding a round trip might add", () => {
    expect(isUnnamed("  untitled project ")).toBe(true);
  });

  it("treats a real name as named", () => {
    expect(isUnnamed("Small To-do App")).toBe(false);
  });

  it("treats an empty name as unnamed", () => {
    // Nothing should produce one, but a project showing a blank bar is exactly the case where
    // naming it from the next prompt is the helpful thing to do.
    expect(isUnnamed("")).toBe(true);
  });
});
