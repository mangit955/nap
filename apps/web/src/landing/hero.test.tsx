import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  const view = render(
    <Hero signedIn value="" onChange={onChange} onSubmit={onSubmit} {...props} />, //
  );
  return { onSubmit, onChange, container: view.container };
}

const BOX = { name: "Describe the app you want" };

describe("signed out", () => {
  it("offers both halves of getting an account, separately", () => {
    // One button asks the person who already has an account to guess it means them too.
    show({ signedIn: false });

    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/sign-up");
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

describe("what is lit", () => {
  it("puts the light on the box you type into, once there is an account", () => {
    // The request the whole split answers: signed in, the lit object *is* the control. The class
    // name is the deliberate exception the rest of the glow already takes — this is colour, and
    // colour has no accessible surface to query.
    const { container } = show({ signedIn: true });

    const lit = container.querySelector(".ai-lights");
    expect(lit).not.toBeNull();
    expect(lit?.contains(screen.getByRole("textbox", BOX))).toBe(true);
  });

  it("shows no picture of software working to somebody who has their own", () => {
    // The card's four faces are a stand-in for having nothing of your own to look at. The step
    // labels are content, not markup, so this fails if the card comes back rather than if its
    // styling changes.
    show({ signedIn: true });

    expect(screen.queryByText("Fetch")).toBeNull();
    expect(screen.queryByText("Parse")).toBeNull();
  });

  it("lights exactly one thing, in either state", () => {
    // Two would be two arcs beating out of step in one room, which is what the shared palette
    // roll exists to prevent.
    const { container: out } = show({ signedIn: false });
    expect(out.querySelectorAll(".ai-lights")).toHaveLength(1);

    cleanup();

    const { container: inside } = show({ signedIn: true });
    expect(inside.querySelectorAll(".ai-lights")).toHaveLength(1);
  });

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
