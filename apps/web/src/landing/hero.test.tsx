import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EXAMPLE_PROMPTS } from "./example-prompts.ts";
import { Hero } from "./hero.tsx";

/**
 * The rim light has no assertions here on purpose: it is colour on `aria-hidden` spans, and
 * jsdom has no canvas to draw its masks on. What these prove is that the box works when the
 * light is not there — which is also what a browser with no 2d context left will render.
 */
function show(props: Partial<Parameters<typeof Hero>[0]> = {}) {
  const onSubmit = vi.fn();
  const onChange = vi.fn();
  render(<Hero value="" onChange={onChange} onSubmit={onSubmit} {...props} />);
  return { onSubmit, onChange };
}

const BOX = { name: "Describe the app you want" };

describe("sending a prompt", () => {
  it("sends what was typed, trimmed", () => {
    const { onSubmit } = show({ value: "  a habit tracker  " });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).toHaveBeenCalledWith("a habit tracker");
  });

  it("cannot be sent empty", () => {
    const { onSubmit } = show({ value: "   " });

    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();

    fireEvent.click(send);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("sends on Enter and makes a newline on Shift+Enter", () => {
    const { onSubmit } = show({ value: "a habit tracker" });
    const box = screen.getByRole("textbox", BOX);

    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("a habit tracker");
  });

  it("accepts nothing further while a project is being made", () => {
    // The press is answered by a navigation, and a second one in the meantime is a second
    // project nobody asked for.
    const { onSubmit } = show({ value: "a habit tracker", busy: true });

    expect(screen.getByRole("textbox", BOX)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    fireEvent.keyDown(screen.getByRole("textbox", BOX), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("the box itself", () => {
  it("reports what was typed", () => {
    const { onChange } = show({ value: "" });

    fireEvent.change(screen.getByRole("textbox", BOX), { target: { value: "a timer" } });

    expect(onChange).toHaveBeenCalledWith("a timer");
  });

  it("puts an example into the box rather than sending it", () => {
    // Pressing an example is a starting point, not a decision — people edit them.
    const { onChange, onSubmit } = show();
    const example = EXAMPLE_PROMPTS[0];

    fireEvent.click(screen.getByRole("button", { name: example }));

    expect(onChange).toHaveBeenCalledWith(example);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("takes the caret when a prompt comes back from signing in", () => {
    // The text reappearing in a box nobody is focused on reads as a leftover draft rather than
    // as the thing they were part-way through doing.
    show({ value: "a habit tracker", restored: true });

    const box = screen.getByRole("textbox", BOX) as HTMLTextAreaElement;
    expect(box).toHaveFocus();
    expect(box.selectionStart).toBe("a habit tracker".length);
  });

  it("leaves the caret alone on an ordinary visit", () => {
    show({ value: "" });

    expect(screen.getByRole("textbox", BOX)).not.toHaveFocus();
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
