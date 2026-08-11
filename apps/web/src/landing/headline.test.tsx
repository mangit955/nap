import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Headline } from "./headline.tsx";

/**
 * The treatment is weight and colour, which have no accessible surface and are checked by eye.
 * What is worth pinning is what setting one word apart can silently break: the heading's
 * accessible name, which is the only version of this sentence a screen reader gets.
 */

const LINES = ["Describe an app.", "Then go take a nap."] as const;
const SUB = "It'll be running by the time you're back.";

const show = (emphasis = "nap") => render(<Headline lines={LINES} sub={SUB} emphasis={emphasis} />);

describe("Headline", () => {
  it("reads as one sentence, with the line break spoken as a space", () => {
    // Wrapping a word in its own element eats the whitespace around it if the space is left to
    // the markup, and the heading is then announced as "take anap." — visually identical, and
    // wrong. Same for the line break, which is a block boundary and no space at all.
    show();

    expect(
      screen.getByRole("heading", { level: 1, name: "Describe an app. Then go take a nap." }),
    ).toBeInTheDocument();
  });

  it("keeps the subheading as prose rather than as part of the heading", () => {
    show();

    expect(screen.getByText(SUB)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveTextContent(SUB);
  });

  it("sets exactly the emphasised word apart, punctuation and all", () => {
    // The copy says "nap." and the caller says "nap": matching on the bare letters is what lets
    // the emphasis survive the full stop moving, or the line being rewritten around it.
    show();
    const heavy = screen.getByRole("heading", { level: 1 }).querySelectorAll("span:not(.block)");

    expect([...heavy].map((word) => word.textContent)).toEqual(["nap."]);
  });

  it("leaves the line evenly set when the emphasis matches nothing", () => {
    // A rewritten headline that no longer contains the word should read as an unemphasised
    // sentence, not throw and not emphasise something arbitrary.
    show("kerning");

    expect(
      screen.getByRole("heading", { level: 1, name: "Describe an app. Then go take a nap." }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1 }).querySelectorAll("span:not(.block)"),
    ).toHaveLength(0);
  });
});
