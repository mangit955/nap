import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { REPO_URL } from "./github-button.tsx";
import { Hero } from "./hero.tsx";

describe("the front page's hero", () => {
  it("says what the product is in one heading", () => {
    render(<Hero />);
    expect(
      screen.getByRole("heading", { level: 1, name: /describe an app\. then go take a nap\./i }),
    ).toBeInTheDocument();
  });

  it("sends the way in to making an account", () => {
    render(<Hero />);
    expect(screen.getByRole("link", { name: "Start building" })).toHaveAttribute(
      "href",
      "/sign-up",
    );
  });

  it("offers the repository beside it", () => {
    render(<Hero />);
    expect(screen.getByRole("link", { name: "Star on GitHub" })).toHaveAttribute("href", REPO_URL);
  });

  it("keeps project creation behind sign-up", () => {
    render(<Hero />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("names the interactive session preview", () => {
    render(<Hero />);
    expect(
      screen.getByRole("group", { name: /interactive nap session demo/i }),
    ).toBeInTheDocument();
  });

  it("stands the session on the photograph rather than under it", () => {
    // The photograph is the wall's own background, so it can never be drawn over the window.
    // An earlier hero laid a mountain mask across the session and hid most of it on a phone.
    render(<Hero />);
    const session = screen.getByRole("group", { name: /interactive nap session demo/i });
    const wall = session.closest(".lp-wall");
    expect(wall).not.toBeNull();
    expect(wall?.children).toHaveLength(1);
  });
});
