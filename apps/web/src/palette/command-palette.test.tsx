import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./command-palette.tsx";
import type { Command } from "./commands.ts";
import { createCommandRegistry } from "./registry.ts";

/**
 * jsdom has `<dialog>` without its methods; these do the one observable thing the real ones do,
 * toggle `open` (see `api-key-panel.test.tsx`). Focus trapping, Escape and the backdrop are the
 * browser's, and are checked in a real one, not here. jsdom's platform is not a Mac, so the
 * chord below is Control and K.
 */
beforeAll(() => {
  const proto = HTMLDialogElement.prototype;
  proto.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

const chord = () => fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });

function setup() {
  const ran: string[] = [];
  const command = (id: string, group: Command["group"], order: number, label: string) => ({
    id,
    group,
    order,
    label,
    icon: null,
    run: vi.fn(() => ran.push(id)),
  });
  const registry = createCommandRegistry();
  const commands = [
    command("new", "Actions", 0, "New session"),
    command("files", "Actions", 2, "Open Files"),
    command("changes", "Actions", 4, "Show changed files"),
    command("fix", "Sessions", 0, "Fix empty-state copy"),
  ];
  registry.add({ current: () => commands });
  render(
    <>
      <button type="button">Before</button>
      <CommandPalette registry={registry} />
    </>,
  );
  const dialog = screen.getByRole("dialog", { hidden: true }) as HTMLDialogElement;
  const field = () => screen.getByRole("combobox", { name: "Search commands and sessions" });
  const options = () => screen.getAllByRole("option").map((option) => option.textContent);
  const highlighted = () =>
    document.getElementById(field().getAttribute("aria-activedescendant") ?? "")?.textContent;
  return { ran, registry, dialog, field, options, highlighted };
}

describe("CommandPalette", () => {
  it("opens on the chord with the field focused and every command listed, actions first", () => {
    const { dialog, field, options, highlighted } = setup();
    expect(dialog.open).toBe(false);
    chord();
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(field());
    expect(options()).toEqual([
      "New session",
      "Open Files",
      "Show changed files",
      "Fix empty-state copy",
    ]);
    expect(highlighted()).toBe("New session");
    expect(screen.getByRole("group", { name: "Actions" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Sessions" })).toBeTruthy();
  });

  it("filters as you type and runs the first match on Enter, closing first", () => {
    const { ran, dialog, field, options } = setup();
    chord();
    fireEvent.change(field(), { target: { value: "file" } });
    expect(options()).toEqual(["Open Files", "Show changed files"]);
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(ran).toEqual(["files"]);
    expect(dialog.open).toBe(false);
  });

  it("moves the highlight with the arrows, wrapping at both ends", () => {
    const { ran, field, highlighted } = setup();
    chord();
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(highlighted()).toBe("Fix empty-state copy");
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(highlighted()).toBe("Open Files");
    expect(screen.getByRole("option", { name: "Open Files" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(ran).toEqual(["files"]);
  });

  it("runs a row that is clicked", () => {
    const { ran } = setup();
    chord();
    fireEvent.click(screen.getByRole("option", { name: "Fix empty-state copy" }));
    expect(ran).toEqual(["fix"]);
  });

  it("gives focus back to where it was when it closes", () => {
    const { dialog } = setup();
    const before = screen.getByRole("button", { name: "Before" });
    before.focus();
    chord();
    expect(document.activeElement).not.toBe(before);
    chord();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(before);
  });

  it("says so when nothing matches, and leaves the list out of the field's references", () => {
    const { field } = setup();
    chord();
    fireEvent.change(field(), { target: { value: "zzz" } });
    expect(screen.getByText("No matching commands or sessions.")).toBeTruthy();
    expect(field().getAttribute("aria-controls")).toBeNull();
    expect(field().getAttribute("aria-activedescendant")).toBeNull();
    fireEvent.keyDown(field(), { key: "Enter" });
  });

  it("starts each opening with an empty query", () => {
    const { field } = setup();
    chord();
    fireEvent.change(field(), { target: { value: "new" } });
    chord();
    chord();
    expect(field()).toHaveProperty("value", "");
  });

  it("reads commands afresh on each opening, though nothing it shows has changed", () => {
    const { registry, options } = setup();
    chord();
    chord();
    registry.add({
      current: () => [
        {
          id: "late",
          group: "Sessions",
          order: 1,
          label: "Arrived late",
          icon: null,
          run: () => {},
        },
      ],
    });
    act(() => {
      chord();
    });
    expect(options()).toContain("Arrived late");
  });

  it("leaves the page alone while another modal is open", () => {
    const { dialog } = setup();
    const other = document.createElement("dialog");
    other.setAttribute("open", "");
    document.body.append(other);
    chord();
    expect(dialog.open).toBe(false);
    other.remove();
  });
});
