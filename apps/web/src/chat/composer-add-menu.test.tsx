import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ComposerAddMenu } from "./composer-add-menu.tsx";

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
  fireEvent.click(screen.getByRole("button", { name: "Add to prompt" }));
  expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  expect(screen.getByRole("menuitem", { name: "Upload media" })).toBeDisabled();
  fireEvent.click(screen.getByRole("menuitem", { name: "Repositories" }));
  expect(onRepositories).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu")).toBeNull();
});
