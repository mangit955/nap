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

function setup({ beforeRun }: { beforeRun?: () => void } = {}) {
  // A command run while the palette is still open is recorded as such, so every expectation on
  // `ran` below also says the palette closed first.
  const ran: string[] = [];
  const command = (id: string, group: Command["group"], order: number, label: string) => ({
    id,
    group,
    order,
    label,
    icon: null,
    run: vi.fn(() =>
      ran.push(document.querySelector("dialog")?.hasAttribute("open") ? `${id} (open)` : id),
    ),
  });
  const registry = createCommandRegistry();
  let commands = [
    command("new", "Actions", 0, "New session"),
    command("files", "Actions", 2, "Open Files"),
    command("changes", "Actions", 4, "Show changed files"),
    command("fix", "Sessions", 0, "Fix empty-state copy"),
  ];
  registry.add({ current: () => commands });
  const replace = (next: typeof commands) => {
    commands = next;
    act(() => registry.changed());
  };
  render(
    <>
      <button type="button">Before</button>
      <CommandPalette registry={registry} beforeRun={beforeRun} />
    </>,
  );
  const dialog = screen.getByRole("dialog", { hidden: true }) as HTMLDialogElement;
  const field = () => screen.getByRole("combobox", { name: "Search commands and sessions" });
  const options = () => screen.getAllByRole("option").map((option) => option.textContent);
  const highlighted = () =>
    document.getElementById(field().getAttribute("aria-activedescendant") ?? "")?.textContent;
  return { ran, registry, dialog, field, options, highlighted, replace, command };
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
    expect(screen.getByRole("status")).toHaveTextContent("No matching commands or sessions.");
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
    // jsdom never makes a dialog modal, so stand one in for the browser's answer to `:modal`.
    const query = document.querySelector.bind(document);
    const spy = vi
      .spyOn(document, "querySelector")
      .mockImplementation((selector: string) =>
        selector === "dialog:modal" ? document.body : query(selector),
      );
    chord();
    expect(dialog.open).toBe(false);
    spy.mockRestore();
  });

  it("opens over a non-modal dialog, such as the thread details card", () => {
    const { dialog } = setup();
    const card = document.createElement("dialog");
    card.setAttribute("open", "");
    document.body.append(card);
    chord();
    expect(dialog.open).toBe(true);
    card.remove();
  });

  it("ignores the chord's auto-repeat while it is held", () => {
    const { dialog } = setup();
    chord();
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true, repeat: true });
    expect(dialog.open).toBe(true);
  });

  it("redraws while open when a source changes, keeping the highlight on its command", () => {
    const { ran, field, options, highlighted, replace, command } = setup();
    chord();
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(highlighted()).toBe("Open Files");
    replace([
      command("new", "Actions", 0, "New session"),
      command("browser", "Actions", 1, "Open Browser"),
      command("files", "Actions", 2, "Open Files"),
    ]);
    expect(options()).toEqual(["New session", "Open Browser", "Open Files"]);
    expect(highlighted()).toBe("Open Files");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(ran).toEqual(["files"]);
  });

  it("keeps the first row highlighted as a command, not a position, when the list reorders", () => {
    const { ran, field, highlighted, replace, command } = setup();
    chord();
    expect(highlighted()).toBe("New session");
    replace([
      command("files", "Actions", -1, "Open Files"),
      command("new", "Actions", 0, "New session"),
    ]);
    expect(highlighted()).toBe("New session");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(ran).toEqual(["new"]);
  });

  it("keeps focus in the field when the list is pressed", () => {
    const { field } = setup();
    chord();
    // A cancelled mousedown is what keeps a click from focusing what was clicked.
    expect(fireEvent.mouseDown(screen.getByText("Actions"))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByRole("option", { name: "Open Files" }))).toBe(false);
    expect(document.activeElement).toBe(field());
  });

  it("puts the page right after closing and before the command runs", () => {
    const order: string[] = [];
    const { field, ran } = setup({
      beforeRun: () =>
        order.push(
          `before: ${document.querySelector("dialog")?.hasAttribute("open") ? "open" : "closed"}`,
          `ran so far: ${ran.length}`,
        ),
    });
    chord();
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(order).toEqual(["before: closed", "ran so far: 0"]);
    expect(ran).toEqual(["new"]);
  });
});
