import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

  it("hides the decorative photograph from assistive technology", () => {
    const { container } = render(<Hero />);
    expect(container.querySelector(".lp-hero-scenery")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelectorAll(".lp-mountain-texture")).toHaveLength(2);
  });
});
