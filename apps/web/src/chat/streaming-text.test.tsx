import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { REVEAL_CLASS, StreamingText } from "./streaming-text.tsx";

/**
 * The reveal has no accessible surface — it is a blur clearing over a few hundred
 * milliseconds — so the one assertion that it happened has to query the word elements
 * directly. That is the same deliberate exception the syntax highlighter makes.
 */
function revealed(container: HTMLElement): string[] {
  return [...container.querySelectorAll(`.${REVEAL_CLASS}`)].map((el) => el.textContent ?? "");
}

describe("StreamingText", () => {
  it("shows the whole passage", () => {
    render(<StreamingText text="I should read App.tsx" live />);

    expect(screen.getByText(/I should read App\.tsx/)).toBeTruthy();
  });

  it("animates only the words that just arrived", () => {
    const { container, rerender } = render(<StreamingText text="I should" live />);
    // The last word wears no trailing space: the passage is still growing, and the space
    // appears once there is a word after it.
    expect(revealed(container)).toEqual(["I ", "should"]);

    rerender(<StreamingText text="I should read" live />);

    // The first two words were already on screen. Animating them again would make the
    // passage flicker from the start every time the model produced another word.
    expect(revealed(container)).toEqual(["I ", "should ", "read"]);
  });

  it("leaves a word's animation alone once it has been assigned", () => {
    const { container, rerender } = render(<StreamingText text="one two" live />);
    const before = container.querySelector(`.${REVEAL_CLASS}`)?.getAttribute("style");

    rerender(<StreamingText text="one two" live />);

    // A rerender with unchanged text must not re-stagger what is already there — a word
    // whose delay is recomputed restarts its own animation mid-flight.
    expect(container.querySelector(`.${REVEAL_CLASS}`)?.getAttribute("style")).toBe(before);
  });

  it("staggers each newly-arrived word after the one before it", () => {
    const { container } = render(<StreamingText text="one two three" live />);
    const delays = [...container.querySelectorAll(`.${REVEAL_CLASS}`)].map((el) =>
      el.getAttribute("style"),
    );

    expect(new Set(delays).size).toBe(3);
  });

  it("animates nothing that was replayed rather than watched", () => {
    // History and finished turns render flat. A transcript that re-ran every passage's
    // reveal on load would look like the agent was working again.
    const { container } = render(<StreamingText text="a finished thought" live={false} />);

    expect(revealed(container)).toEqual([]);
    expect(screen.getByText(/a finished thought/)).toBeTruthy();
  });

  it("marks a live passage with a caret and a settled one without", () => {
    const { container, rerender } = render(<StreamingText text="still going" live />);
    expect(container.querySelector("[data-caret]")).toBeTruthy();

    rerender(<StreamingText text="still going" live={false} />);

    expect(container.querySelector("[data-caret]")).toBeNull();
  });

  it("is not announced word by word", () => {
    // The transcript is a `role="log"`, so everything inside it is a live region by
    // inheritance. A passage that grows twice a second would be read aloud twice a second,
    // over the top of the step lines that carry the facts worth hearing.
    const { container } = render(<StreamingText text="thinking out loud" live />);

    expect(container.firstElementChild?.getAttribute("aria-live")).toBe("off");
  });

  it("reads as one sentence rather than a list of words", () => {
    // Split into a span per word for the stagger — but an assistive technology reading
    // each span separately would hear "I. should. read." So the text is also present whole.
    render(<StreamingText text="I should read" live />);

    expect(screen.getByText("I should read")).toBeTruthy();
  });
});
