import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EXAMPLE_PROMPTS } from "./example-prompts.ts";
import { Hero } from "./hero.tsx";

/**
 * The rim light has no assertions here on purpose: it is colour on `aria-hidden` spans, and
 * jsdom has no canvas to draw its masks on. What these prove is that the hero works when the
 * light is not there — which is also what a browser with no 2d context left will render.
 */
function show(props: Partial<Parameters<typeof Hero>[0]> = {}) {
  const onSubmit = vi.fn();
  const onChange = vi.fn();
  render(
    <Hero signedIn value="" onChange={onChange} onSubmit={onSubmit} {...props} />, //
  );
  return { onSubmit, onChange };
}

const BOX = { name: "Describe the app you want" };

describe("signed out", () => {
  it("offers both halves of getting an account, separately", () => {
    // One button asks the person who already has an account to guess it means them too.
    show({ signedIn: false });

    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute(
      "href",
      "/sign-in?mode=sign-up",
    );
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
  });

  it("offers no prompt box", () => {
    // A sentence typed here would have to survive an authentication redirect, and every step of
    // that is a place to lose it.
    show({ signedIn: false });

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
  });

  it("offers no examples either, since there is nowhere to put one", () => {
    show({ signedIn: false });

    expect(screen.queryByRole("button", { name: EXAMPLE_PROMPTS[0] })).not.toBeInTheDocument();
  });
});

describe("the card", () => {
  it("is a picture, not a control", () => {
    // It changes what it is every few seconds. A label never re-announces, so any name it
    // carried would be wrong seconds after being read.
    show({ signedIn: false });

    // The only controls on a signed-out hero are the two ways in.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });
});

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
    // The press is answered by a navigation, and a second one meanwhile is a second project
    // nobody asked for.
    const { onSubmit } = show({ value: "a habit tracker", busy: true });

    expect(screen.getByRole("textbox", BOX)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    fireEvent.keyDown(screen.getByRole("textbox", BOX), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("reports what was typed", () => {
    const { onChange } = show({ value: "" });

    fireEvent.change(screen.getByRole("textbox", BOX), { target: { value: "a timer" } });

    expect(onChange).toHaveBeenCalledWith("a timer");
  });
});

describe("the examples", () => {
  it("put a prompt into the box rather than sending it", () => {
    // A starting point, not a decision — people edit them.
    const { onChange, onSubmit } = show();
    const example = EXAMPLE_PROMPTS[0];

    fireEvent.click(screen.getByRole("button", { name: example }));

    expect(onChange).toHaveBeenCalledWith(example);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("leave the caret where the editing happens", () => {
    show();

    fireEvent.click(screen.getByRole("button", { name: EXAMPLE_PROMPTS[0] }));

    expect(screen.getByRole("textbox", BOX)).toHaveFocus();
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
