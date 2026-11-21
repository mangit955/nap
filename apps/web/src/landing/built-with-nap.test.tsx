import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BuiltWithNap } from "./built-with-nap.tsx";
import { EXAMPLE_APPS } from "./example-apps.ts";

describe("the example apps", () => {
  it("pairs each app with its prompt and a link to the live page", () => {
    render(<BuiltWithNap />);
    const cards = screen.getAllByRole("listitem");
    expect(cards).toHaveLength(EXAMPLE_APPS.length);
    for (const [index, app] of EXAMPLE_APPS.entries()) {
      const card = within(cards[index] as HTMLElement);
      expect(card.getByText(app.prompt)).toBeInTheDocument();
      expect(card.getByRole("link", { name: /open app/i })).toHaveAttribute("href", app.href);
    }
  });

  it("gives every link a name of its own", () => {
    render(<BuiltWithNap />);
    const names = screen.getAllByRole("link").map((link) => link.textContent);
    expect(new Set(names).size).toBe(names.length);
  });

  it("claims nothing about how the apps were made", () => {
    // They were written by hand for the page, so turn counts or "from one prompt" would be false.
    const { container } = render(<BuiltWithNap />);
    expect(container.textContent).not.toMatch(/\d\s*turns?|one prompt/i);
  });
});
