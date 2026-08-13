import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Capabilities, SPACE } from "./capabilities.tsx";

describe("what you get", () => {
  it("is a list, whichever layout it is drawn in", () => {
    // The poured version is absolutely positioned and looks nothing like a list on screen; it has
    // to stay one underneath, or the only thing announcing five separate claims is the shape.
    render(<Capabilities />);

    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(5);
  });

  it("says each thing exactly once", () => {
    // The wide and narrow layouts are one set of markup on purpose. Two copies hidden at
    // different breakpoints would be two places for the copy to drift, and every heading in the
    // document twice for anything reading it rather than looking at it.
    render(<Capabilities />);
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);

    expect(titles).toHaveLength(5);
    expect(new Set(titles).size).toBe(5);
  });

  it("hides the poured skin from the accessibility tree", () => {
    // It is colour. Announced, it is an unnamed graphic between every pair of headings.
    const { container } = render(<Capabilities />);
    const skin = container.querySelector("svg");

    expect(skin).toHaveAttribute("aria-hidden", "true");
  });

  it("scales the same box the skin was traced for", () => {
    // The wide layout's box is a Tailwind class, which has to be a literal in the source — so the
    // design space is written down twice and nothing but this stops the two drifting. When they
    // do, every tile sits slightly off the shape drawn behind it, at some widths only.
    const { container } = render(<Capabilities />);
    const markup = container.innerHTML;

    expect(markup).toContain(`md:aspect-[${SPACE.w}/${SPACE.h}]`);
    expect(markup).toContain(`md:h-[${SPACE.h}px]`);
    expect(markup).toContain(`md:w-[${SPACE.w}px]`);
    expect(markup).toContain(`calc(100cqw/${SPACE.w})`);
  });

  it("draws its five tiles as a single fused surface", () => {
    // The claim the section makes is that this is one thing, not five — so the outline has to be
    // one closed curve. Five subpaths here means the gaps outgrew the blend and every tile is
    // just a rounded box again, which is invisible until somebody looks at the page.
    const { container } = render(<Capabilities />);
    const outline = container.querySelector("path")?.getAttribute("d") ?? "";

    expect(outline.split("Z").filter((part) => part.trim() !== "")).toHaveLength(1);
  });
});
