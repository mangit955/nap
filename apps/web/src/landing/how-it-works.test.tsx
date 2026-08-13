import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HowItWorks } from "./how-it-works.tsx";

describe("the three beats of a turn", () => {
  it("labels itself, so the section is findable rather than an unnamed region", () => {
    render(<HowItWorks />);

    expect(
      screen.getByRole("region", { name: /you describe it\. nap builds it/i }),
    ).toBeInTheDocument();
  });

  it("tells the story in order", () => {
    // Source order is reading order on a phone; the alternating sides are a wide-screen effect
    // laid on top of it, so this is what somebody actually reads.
    render(<HowItWorks />);
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);

    expect(titles).toEqual(["Say it in one sentence", "Then nod off", "Wake up to it running"]);
  });

  it("keeps its pictures out of the accessibility tree", () => {
    // They are drawings of the product, and the sentence beside each one is what says the thing.
    // Announced, a reader would get "pencil, src/app/page.tsx, check" instead of a beat.
    //
    // Asserted through `closest`, not through a text query: testing-library's text queries walk
    // the DOM and happily find content inside an `aria-hidden` subtree, so `queryByText(...)
    // .not.toBeInTheDocument()` would fail here even though nothing announces it.
    render(<HowItWorks />);

    for (const text of ["build me a habit tracker", "habit-tracker.nap.run", "12 actions"]) {
      expect(screen.getByText(text).closest("[aria-hidden='true']")).not.toBeNull();
    }
  });

  it("offers nothing to press", () => {
    // Every way in on this page is in the hero or the closing band. A link here would be a fourth
    // place to click for the same thing, in the middle of an explanation.
    const { container } = render(<HowItWorks />);
    const section = within(container);

    expect(section.queryAllByRole("link")).toHaveLength(0);
    expect(section.queryAllByRole("button")).toHaveLength(0);
  });
});
