import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_PROMPTS } from "./example-prompts.ts";
import { Hero } from "./hero.tsx";

/**
 * The rim light has no assertions here on purpose: it is colour on `aria-hidden` spans, and
 * jsdom has no canvas to draw its masks on. What these prove is that the card works when the
 * light is not there — which is also what a browser with no 2d context left will render.
 *
 * The card starts as a *demonstration*, so there is no input on screen until somebody engages
 * with it. Almost every test here therefore settles it first, which is itself the thing worth
 * being sure of: if settling ever stopped working, nobody could type at all.
 */
function show(props: Partial<Parameters<typeof Hero>[0]> = {}) {
  const onSubmit = vi.fn();
  const onChange = vi.fn();
  render(<Hero value="" onChange={onChange} onSubmit={onSubmit} {...props} />);
  return { onSubmit, onChange };
}

const BOX = { name: "Describe the app you want" };

/** The handover is a chain of timers; the input is not mounted until they have run. */
function runTimeline() {
  act(() => {
    vi.advanceTimersByTime(2000);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  return () => vi.useRealTimers();
});

describe("before anybody touches it", () => {
  it("shows no input, only an invitation", () => {
    show();

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", BOX)).toBeInTheDocument();
  });

  it("hides the surfaces it is cycling through from assistive technology", () => {
    // It changes what it is every few seconds. A label never re-announces, so naming each shape
    // would either lie or say nothing; the invitation over it carries the name instead.
    show();

    expect(screen.queryByText("Indexing")).not.toBeInTheDocument();
  });
});

describe("settling", () => {
  it("hands over to a real input when pressed", () => {
    show();

    fireEvent.click(screen.getByRole("button", BOX));
    runTimeline();

    expect(screen.getByRole("textbox", BOX)).toBeInTheDocument();
  });

  it("keeps the first character when somebody just starts typing", () => {
    // Losing the letter that summoned the box is the sort of thing people only notice by
    // finding a word missing its first letter after they have typed the rest.
    const { onChange } = show({ value: "" });

    fireEvent.keyDown(screen.getByRole("button", BOX), { key: "a" });

    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("is already settled when a prompt came back from signing in", () => {
    show({ value: "a habit tracker", restored: true });
    runTimeline();

    expect(screen.getByRole("textbox", BOX)).toBeInTheDocument();
    expect(screen.queryByRole("button", BOX)).not.toBeInTheDocument();
  });

  it("takes the caret once it has settled", () => {
    show({ value: "a habit tracker", restored: true });
    runTimeline();

    const box = screen.getByRole("textbox", BOX) as HTMLTextAreaElement;
    expect(box).toHaveFocus();
    expect(box.selectionStart).toBe("a habit tracker".length);
  });
});

describe("sending a prompt", () => {
  function settled(props: Partial<Parameters<typeof Hero>[0]> = {}) {
    const handlers = show({ restored: true, ...props });
    runTimeline();
    return handlers;
  }

  it("sends what was typed, trimmed", () => {
    const { onSubmit } = settled({ value: "  a habit tracker  " });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).toHaveBeenCalledWith("a habit tracker");
  });

  it("cannot be sent empty", () => {
    const { onSubmit } = settled({ value: "   " });

    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();

    fireEvent.click(send);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("sends on Enter and makes a newline on Shift+Enter", () => {
    const { onSubmit } = settled({ value: "a habit tracker" });
    const box = screen.getByRole("textbox", BOX);

    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("a habit tracker");
  });

  it("accepts nothing further while a project is being made", () => {
    // The press is answered by a navigation, and a second one meanwhile is a second project
    // nobody asked for.
    const { onSubmit } = settled({ value: "a habit tracker", busy: true });

    expect(screen.getByRole("textbox", BOX)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    fireEvent.keyDown(screen.getByRole("textbox", BOX), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("reports what was typed", () => {
    const { onChange } = settled({ value: "" });

    fireEvent.change(screen.getByRole("textbox", BOX), { target: { value: "a timer" } });

    expect(onChange).toHaveBeenCalledWith("a timer");
  });
});

describe("the examples", () => {
  it("put a prompt into the box rather than sending it", () => {
    // Pressing an example is a starting point, not a decision — people edit them.
    const { onChange, onSubmit } = show();
    const example = EXAMPLE_PROMPTS[0];

    fireEvent.click(screen.getByRole("button", { name: example }));

    expect(onChange).toHaveBeenCalledWith(example);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("settle the card, so the text has somewhere to land", () => {
    show();

    fireEvent.click(screen.getByRole("button", { name: EXAMPLE_PROMPTS[0] }));
    runTimeline();

    expect(screen.getByRole("textbox", BOX)).toBeInTheDocument();
  });
});

describe("when something goes wrong", () => {
  it("says so where a screen reader will hear it", () => {
    show({ error: "Could not reach the server." });

    expect(screen.getByRole("alert")).toHaveTextContent("Could not reach the server.");
  });

  it("says nothing when nothing has", () => {
    show();

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
