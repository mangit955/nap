import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dashboard } from "./dashboard.tsx";

/**
 * The frame: a rail on the left, with scrolling confined to the content column rather than the
 * full dashboard page.
 *
 * Structural only, so it can be mounted without a session, a router or a network — the same
 * split `landing.tsx` and every pane in the workspace use.
 */

function show() {
  render(
    <Dashboard
      sidebar={<nav aria-label="Dashboard">rail</nav>}
      hero={<p>greeting</p>}
      grid={<p>projects</p>}
    />,
  );
}

describe("the dashboard frame", () => {
  it("puts the rail and the page in two landmarks a reader can move between", () => {
    show();

    expect(screen.getByRole("navigation", { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("renders the hero above the grid inside the main column", () => {
    show();

    const main = screen.getByRole("main");
    expect(main).toHaveTextContent("greeting");
    expect(main).toHaveTextContent("projects");
    // The rail is beside the page, not inside it: a nav nested in `main` is not a landmark
    // anybody can skip to.
    expect(main).not.toHaveTextContent("rail");
  });

  it("keeps page overflow clipped while the content column remains the scroll region", () => {
    show();

    expect(screen.getByRole("main")).toHaveClass("overflow-y-auto");
    expect(screen.getByRole("main")).toHaveClass("nap-scroll-hidden");
    expect(screen.getByRole("main").parentElement).toHaveClass("overflow-hidden");
  });
});
