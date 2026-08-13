import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Hero } from "./hero.tsx";

/**
 * The rim light has no assertions here on purpose: it is colour on `aria-hidden` spans, and
 * jsdom has no canvas to draw its masks on. What these prove is that the hero works when the
 * light is not there — which is also what a browser with no 2d context left will render.
 */
function show() {
  const view = render(<Hero />);
  return { container: view.container };
}

describe("the front page's hero", () => {
  it("offers both halves of getting an account, separately", () => {
    // One button asks the person who already has an account to guess it means them too.
    show();

    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/sign-up");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
  });

  it("offers no prompt box", () => {
    // A sentence typed here would have to survive an authentication redirect, and every step of
    // that is a place to lose it. The box lives on the dashboard, behind the sign-in.
    show();

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
  });

  it("lights exactly one thing", () => {
    // Two would be two arcs beating out of step in one room, which is what the shared palette
    // roll exists to prevent. The class name is the deliberate exception the rest of the glow
    // already takes — this is colour, and colour has no accessible surface to query.
    const { container } = show();

    expect(container.querySelectorAll(".ai-lights")).toHaveLength(1);
  });

  it("shows a picture of software working, not a control", () => {
    // The card changes what it is every few seconds. A label never re-announces, so any name it
    // carried would be wrong seconds after being read — and the only controls on this page are
    // the two ways in.
    show();

    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });
});
