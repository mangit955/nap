import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ComposerAddMenu } from "./composer-add-menu.tsx";

/*
 * The menu stays mounted while closed so it can fade out, and neither jsdom nor Testing Library
 * understands `inert` — a closed menu's items are found by role and still answer a click. So these
 * tests read the open state from `aria-expanded` and `inert` directly: finding a menuitem proves
 * nothing about whether the menu opened.
 */

it("has exactly two actions and keeps Repositories enabled for a text-only model", () => {
  const onRepositories = vi.fn();
  render(
    <ComposerAddMenu
      disabled={false}
      mediaSupported={false}
      onFiles={vi.fn()}
      onRepositories={onRepositories}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Add to prompt" });
  const menu = screen.getByRole("menu");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(menu).toHaveAttribute("inert");

  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(menu).not.toHaveAttribute("inert");
  expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  expect(screen.getByRole("menuitem", { name: "Upload media" })).toBeDisabled();

  fireEvent.click(screen.getByRole("menuitem", { name: "Repositories" }));
  expect(onRepositories).toHaveBeenCalledOnce();
  // Closed but still mounted, so it can fade out: unreachable rather than absent.
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(menu).toHaveAttribute("inert");
});
