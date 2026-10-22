import { describe, expect, it } from "vitest";
import { ansiSpans } from "./ansi.ts";

/**
 * Terminal output into styled runs. `run_command` streams whatever the program printed, colour
 * codes included, and printing the escapes raw fills a build log with `[32m`.
 */

describe("ansiSpans", () => {
  it("passes plain text through as one run", () => {
    expect(ansiSpans("vite ready\n")).toEqual([{ text: "vite ready\n", classes: [] }]);
  });

  it("colours what follows a colour code and resets on 0", () => {
    expect(ansiSpans("a\u001b[31merror\u001b[0m b")).toEqual([
      { text: "a", classes: [] },
      { text: "error", classes: ["ansi-red"] },
      { text: " b", classes: [] },
    ]);
  });

  it("combines weight and colour, and clears only what 39 and 22 clear", () => {
    expect(ansiSpans("\u001b[1;32mok\u001b[39m!\u001b[22mx")).toEqual([
      { text: "ok", classes: ["ansi-bold", "ansi-green"] },
      { text: "!", classes: ["ansi-bold"] },
      { text: "x", classes: [] },
    ]);
  });

  it("maps the bright colours onto the same names", () => {
    expect(ansiSpans("\u001b[91mx")).toEqual([{ text: "x", classes: ["ansi-red"] }]);
  });

  it("skips the arguments of a 256-colour or truecolour code rather than reading them as codes", () => {
    // `38;5;1` is colour 1 of 256, not bold; `48;5;31` is a background, not red text.
    expect(ansiSpans("\u001b[38;5;1ma\u001b[48;5;31mb\u001b[38;2;255;0;32mc")).toEqual([
      { text: "abc", classes: [] },
    ]);
    expect(ansiSpans("\u001b[38;5;2;31mx")).toEqual([{ text: "x", classes: ["ansi-red"] }]);
  });

  it("drops escapes that move the cursor rather than colour text", () => {
    expect(ansiSpans("\u001b[2K\u001b[1Gdone\u001b]0;title\u0007")).toEqual([
      { text: "done", classes: [] },
    ]);
  });

  it("keeps only the last frame of a line a progress bar redrew", () => {
    // `bun install` redraws one line with carriage returns; all but the last frame are gone from
    // a real terminal, and keeping them prints the bar fifty times.
    expect(ansiSpans("10%\r50%\r100%\ndone\r\n")).toEqual([{ text: "100%\ndone\n", classes: [] }]);
  });
});
