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
    // Source order is reading order; the demo beside it plays these acts in the same sequence.
    render(<HowItWorks />);
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);

    expect(titles).toEqual(["Say it in one sentence", "Then nod off", "Wake up to it running"]);
  });

  it("reads at full strength until something is actually playing", () => {
    // The lit beat arrives as `data-beat`, written by the stage once it starts. Nothing writes it
    // under reduced motion or with no script — so the resting state has to be *all three legible*,
    // not all three dimmed waiting for a highlight that will never come.
    const { container } = render(<HowItWorks />);

    expect(container.querySelector("section")).not.toHaveAttribute("data-beat");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("keeps the demo out of the accessibility tree", () => {
    // It is an illustration of what the copy says. Asserted through `closest` because a text
    // query walks the DOM, not the accessibility tree, and would find this either way.
    render(<HowItWorks />);

    expect(
      screen.getByText("habit-tracker.nap.run").closest("[aria-hidden='true']"),
    ).not.toBeNull();
  });

  it("offers nothing to press", () => {
    // Every way in is in the hero or the closing band. A control here would be a fourth place to
    // click for the same thing, in the middle of an explanation — and the demo's own send button
    // is a drawing, not a button.
    const { container } = render(<HowItWorks />);
    const section = within(container);

    expect(section.queryAllByRole("link")).toHaveLength(0);
    expect(section.queryAllByRole("button")).toHaveLength(0);
  });
});
