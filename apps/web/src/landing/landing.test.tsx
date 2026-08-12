import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type AuthState, Landing } from "./landing.tsx";

function show(auth: AuthState) {
  render(<Landing auth={auth} hero={<p>hero</p>} />);
}

describe("before the session has resolved", () => {
  it("offers no way in", () => {
    // Guessing puts a Sign in link under the cursor of somebody who is already signed in and
    // about to be redirected to their dashboard.
    show("pending");

    expect(screen.queryByRole("link", { name: /sign in/i })).not.toBeInTheDocument();
  });

  it("still shows the hero, because it is the page", () => {
    show("pending");

    expect(screen.getByText("hero")).toBeInTheDocument();
  });
});

describe("signed out", () => {
  it("offers a way in", () => {
    show("signed-out");

    expect(screen.getByRole("link", { name: /sign in/i })).toHaveAttribute("href", "/sign-in");
  });
});

describe("the frame", () => {
  it("has exactly one main landmark", () => {
    show("signed-out");

    expect(screen.getAllByRole("main")).toHaveLength(1);
  });
});
