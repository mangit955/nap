import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";
import { SessionActions } from "./session-actions.tsx";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

it("renames through a focused dialog and trims the new name", () => {
  const onRename = vi.fn();
  render(<SessionActions name="Portfolio" onRename={onRename} />);
  fireEvent.click(screen.getByRole("button", { name: "Session actions for Portfolio" }));
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), {
    target: { value: "  Personal site  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onRename).toHaveBeenCalledWith("Personal site");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("deletes only after the confirmation and allows cancelling", () => {
  const onDelete = vi.fn();
  render(<SessionActions name="Portfolio" onDelete={onDelete} />);
  const open = () => {
    fireEvent.click(screen.getByRole("button", { name: "Session actions for Portfolio" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
  };
  open();
  expect(onDelete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onDelete).not.toHaveBeenCalled();
  open();
  fireEvent.click(screen.getByRole("button", { name: "Delete session" }));
  expect(onDelete).toHaveBeenCalledOnce();
});

it("dismisses actions on Escape and restores the trigger", () => {
  render(<SessionActions name="Portfolio" onRename={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "Session actions for Portfolio" });
  fireEvent.click(trigger);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("keeps actions open while their menu scrolls, but closes when the anchor moves", () => {
  render(<SessionActions name="Portfolio" onRename={vi.fn()} onDelete={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Session actions for Portfolio" }));
  fireEvent.scroll(screen.getByRole("group", { name: "Actions for Portfolio" }));
  expect(screen.getByRole("button", { name: "Delete project" })).toBeInTheDocument();
  fireEvent.scroll(window);
  expect(screen.queryByRole("button", { name: "Delete project" })).not.toBeInTheDocument();
});
