import { describe, expect, it } from "vitest";
import {
  cleanTitle,
  TITLE_INITIAL_CHARACTERS,
  TITLE_REGENERATE_CHARACTERS,
  titlePrompt,
} from "./session-title.ts";

const message = "build me a habit tracker where my team logs standups and sees streaks";
const context = { messages: [message], sourceName: null };

describe("cleanTitle", () => {
  it("tidies a good answer: one line, no quotes, label or trailing punctuation", () => {
    expect(cleanTitle("Team Standup Streak Tracker", context)).toBe("Team Standup Streak Tracker");
    expect(cleanTitle('  "Team Standup Streak Tracker."  \n', context)).toBe(
      "Team Standup Streak Tracker",
    );
    expect(cleanTitle("Title: Team standup streaks!\nBecause…", context)).toBe(
      "Team standup streaks",
    );
    expect(cleanTitle("“Standup  streak   tracker”", context)).toBe("Standup streak tracker");
  });

  it("refuses an answer outside T3's limits", () => {
    expect(cleanTitle("Streaks", context)).toBeNull();
    expect(cleanTitle("Standup streaks", context)).toBeNull();
    expect(cleanTitle("One two three four five six seven eight nine", context)).toBeNull();
    expect(cleanTitle("Comprehensive standup accountability dashboard", context)).toBeNull();
    expect(cleanTitle("", context)).toBeNull();
    expect(cleanTitle("...", context)).toBeNull();
  });

  it("refuses a copy or a truncation of the person's message", () => {
    expect(cleanTitle("Build me a habit tracker", context)).toBeNull();
    expect(cleanTitle("build me a habit", context)).toBeNull();
    expect(
      cleanTitle("Make the button blue", { messages: ["make the button blue"], sourceName: null }),
    ).toBeNull();
  });

  it("refuses the source name the card already shows, and the placeholder", () => {
    const imported = {
      messages: ["fix the login redirect"],
      sourceName: "acme/storefront-web-app",
    };
    expect(cleanTitle("Storefront web app", imported)).toBeNull();
    expect(cleanTitle("acme storefront web app", imported)).toBeNull();
    expect(cleanTitle("Login redirect loop fix", imported)).toBe("Login redirect loop fix");
    expect(cleanTitle("Untitled project here", context)).toBe("Untitled project here");
    expect(cleanTitle("Untitled Project", { messages: [], sourceName: null })).toBeNull();
  });
});

describe("titlePrompt", () => {
  it("bounds what it carries, for a first title and a regenerated one", () => {
    const long = "x".repeat(TITLE_INITIAL_CHARACTERS * 3);
    const initial = titlePrompt({ messages: [long] });
    expect(initial).toContain("User message:");
    expect(initial.length).toBeLessThan(TITLE_INITIAL_CHARACTERS + 2000);
    const again = titlePrompt({ messages: [long, long, long], previousTitle: "Old name" });
    expect(again).toContain('The previous title was "Old name"');
    expect(again.length).toBeLessThan(TITLE_REGENERATE_CHARACTERS + 2000);
  });
});
