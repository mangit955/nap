import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type AuthState, Landing } from "./landing.tsx";

function show(auth: AuthState) {
  const onSignOut = vi.fn();
  render(
    <Landing
      auth={auth}
      hero={<p>hero</p>}
      projects={<h2>Your projects</h2>}
      onSignOut={onSignOut}
    />,
  );
  return { onSignOut };
}

describe("before the session has resolved", () => {
  it("offers neither way in nor way out", () => {
    // Guessing puts a Sign in link under the cursor of somebody already signed in, and then
    // swaps it for Sign out under their finger.
    show("pending");

    expect(screen.queryByRole("link", { name: /sign in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
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

  it("shows no project list", () => {
    // There is nobody to have one, and mounting it would fire a request that can only 401.
    show("signed-out");

    expect(screen.queryByRole("heading", { name: /your projects/i })).not.toBeInTheDocument();
  });
});

describe("signed in", () => {
  it("shows the hero and the projects under it", () => {
    show("signed-in");

    expect(screen.getByText("hero")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /your projects/i })).toBeInTheDocument();
  });

  it("offers a way out", () => {
    const { onSignOut } = show("signed-in");

    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

    expect(onSignOut).toHaveBeenCalled();
  });
});

describe("the frame", () => {
  it("has exactly one main landmark", () => {
    show("signed-in");

    expect(screen.getAllByRole("main")).toHaveLength(1);
  });
});
