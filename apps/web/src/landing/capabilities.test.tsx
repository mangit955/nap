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

  it("hands the stylesheet the same space the skin was traced from", () => {
    // The tiles are placed in plain pixels and the shape behind them is traced from those same
    // numbers, so the box that scales them has to be *these* numbers and not a second copy. It is
    // a custom property rather than a class for a blunt reason: the Tailwind arbitrary properties
    // this used to be — `[scale:calc(100cqw/880)]`, `aspect-[880/492]` — compile to nothing at
    // all, and the section rendered at 1:1 and overflowed its column for a whole session.
    const { container } = render(<Capabilities />);
    const host = container.querySelector(".nap-space-host-md");

    expect(host).toHaveStyle({ "--space-w": `${SPACE.w}`, "--space-h": `${SPACE.h}` });
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
