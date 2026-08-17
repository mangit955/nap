import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { REPO_URL } from "./github-button.tsx";
import { type AuthState, Landing } from "./landing.tsx";

function show(auth: AuthState) {
  render(<Landing auth={auth} hero={<p>hero</p>} />);
}

/** The bar, specifically: the page now offers the same two links again at its foot. */
const bar = () => within(screen.getByRole("banner"));

describe("before the session has resolved", () => {
  it("offers no way in from the bar", () => {
    // Guessing puts a Sign in link under the cursor of somebody who is already signed in and
    // about to be redirected to their dashboard.
    show("pending");

    expect(bar().queryByRole("link", { name: /sign in/i })).not.toBeInTheDocument();
  });

  it("still shows the hero, because it is the page", () => {
    show("pending");

    expect(screen.getByText("hero")).toBeInTheDocument();
  });
});

describe("signed out", () => {
  it("offers a way in", () => {
    show("signed-out");

    expect(bar().getByRole("link", { name: /sign in/i })).toHaveAttribute("href", "/sign-in");
  });
});

describe("the repository link", () => {
  it("points at the source", () => {
    show("signed-out");

    expect(bar().getByRole("link", { name: /star on github/i })).toHaveAttribute("href", REPO_URL);
  });

  it("is there before the session resolves, because it is right either way", () => {
    show("pending");

    expect(bar().getByRole("link", { name: /star on github/i })).toBeInTheDocument();
  });
});

describe("the way into the docs", () => {
  it("is offered from the bar", () => {
    show("signed-out");

    expect(bar().getByRole("link", { name: /^docs$/i })).toHaveAttribute("href", "/docs");
  });

  it("is offered again at the foot of the page, where the bar has long gone", () => {
    show("signed-out");
    const footer = within(screen.getByRole("contentinfo"));

    expect(footer.getByRole("link", { name: /^docs$/i })).toHaveAttribute("href", "/docs");
  });

  it("is there before the session resolves, because it is right either way", () => {
    // Same argument as the repository link: nothing about the docs depends on who is asking.
    show("pending");

    expect(bar().getByRole("link", { name: /^docs$/i })).toBeInTheDocument();
  });
});

describe("the frame", () => {
  it("has exactly one main landmark", () => {
    show("signed-out");

    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("has exactly one footer, outside the main content", () => {
    show("signed-out");
    const footer = screen.getByRole("contentinfo");

    expect(within(screen.getByRole("main")).queryByRole("contentinfo")).not.toBeInTheDocument();
    expect(footer).toBeInTheDocument();
  });

  it("carries the page's story under the hero, in order", () => {
    // The hero is a slot and the sections are not: they ask the server nothing, so threading them
    // through a prop would be ceremony around three constants. This is what says they are here.
    show("signed-out");
    const sections = screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-labelledby"));

    expect(sections).toEqual(["how-it-works", "capabilities", "closing"]);
  });

  it("keeps the light ink ramp scoped to the page rather than the whole app", () => {
    // Declared at `:root` this ramp would restyle the dark workspace by accident, and the failure
    // is somebody else's page turning white weeks later.
    const { container } = render(<Landing auth="signed-out" hero={<p>hero</p>} />);

    expect(container.firstElementChild).toHaveClass("ai-stage-ink");
  });
});
