import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditableTitle } from "./editable-title.tsx";

/**
 * The name you can change by clicking it.
 *
 * Queried by role and accessible name throughout: the resting state is a *button* and the open
 * state is a *textbox*, and that swap is the behaviour, not an implementation detail.
 */

function show(name = "Small To-do App") {
  const onRename = vi.fn();
  render(<EditableTitle name={name} onRename={onRename} />);
  return { onRename };
}

const open = () => fireEvent.click(screen.getByRole("button"));
const field = () => screen.getByRole("textbox");

describe("at rest", () => {
  it("shows the name", () => {
    show();

    expect(screen.getByRole("button", { name: /Small To-do App/ })).toBeInTheDocument();
  });

  it("says that pressing it renames, rather than leaving that to a hover", () => {
    // The pencil only appears under the cursor, which is no affordance at all for somebody on a
    // keyboard or a screen reader. The label is what makes the control discoverable.
    show();

    expect(screen.getByRole("button", { name: /rename/i })).toBeInTheDocument();
  });

  it("is not a text field until it is asked to be", () => {
    // A field that always looks like a field puts a box around a name that is almost never
    // being edited, and makes the workspace bar read as a form.
    show();

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});

describe("committing", () => {
  it("saves on Enter", () => {
    const { onRename } = show();
    open();

    fireEvent.change(field(), { target: { value: "Renamed" } });
    fireEvent.keyDown(field(), { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("Renamed");
  });

  it("saves on blur", () => {
    // Typing and then clicking elsewhere is the ordinary way people finish; losing the edit
    // there is the behaviour that makes a control like this infuriating.
    const { onRename } = show();
    open();

    fireEvent.change(field(), { target: { value: "Renamed" } });
    fireEvent.blur(field());

    expect(onRename).toHaveBeenCalledWith("Renamed");
  });

  it("trims what it sends", () => {
    const { onRename } = show();
    open();

    fireEvent.change(field(), { target: { value: "  Padded  " } });
    fireEvent.keyDown(field(), { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("Padded");
  });

  it("closes again once saved", () => {
    show();
    open();
    fireEvent.keyDown(field(), { key: "Enter" });

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});

describe("discarding", () => {
  it("reverts on Escape without saving", () => {
    // Escape is the deliberate way out, and it is the one that throws the edit away.
    const { onRename } = show();
    open();

    fireEvent.change(field(), { target: { value: "Never mind" } });
    fireEvent.keyDown(field(), { key: "Escape" });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Small To-do App/ })).toBeInTheDocument();
  });

  it("does not save the discarded edit on the blur that follows Escape", () => {
    // Escape closes the field, which blurs it — and blur commits. Without the revert happening
    // first, pressing Escape would save the very edit it was pressed to discard.
    const { onRename } = show();
    open();

    fireEvent.change(field(), { target: { value: "Never mind" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    fireEvent.blur(screen.getByRole("button"));

    expect(onRename).not.toHaveBeenCalled();
  });
});

describe("what it refuses to send", () => {
  it("sends nothing when the name is unchanged", () => {
    // Clicking in and out of a name must not write to the database.
    const { onRename } = show();
    open();
    fireEvent.blur(field());

    expect(onRename).not.toHaveBeenCalled();
  });

  it("sends nothing for an empty name", () => {
    // The server refuses it anyway, so reverting is a better answer than a round trip that
    // fails — and a blank bar reads as a record that failed to load, not as an unnamed project.
    const { onRename } = show();
    open();

    fireEvent.change(field(), { target: { value: "   " } });
    fireEvent.keyDown(field(), { key: "Enter" });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Small To-do App/ })).toBeInTheDocument();
  });

  it("ignores Enter while an IME is composing", () => {
    // Taking Enter from a composing IME commits a half-written word.
    const { onRename } = show();
    open();

    fireEvent.change(field(), { target: { value: "日本" } });
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });

    expect(onRename).not.toHaveBeenCalled();
  });
});

describe("a name that changed elsewhere", () => {
  it("follows it while not being edited", () => {
    // The agent names a project on its first turn, which lands while somebody is looking at the
    // bar. A control holding its first render would go on showing "Untitled project".
    const { rerender } = render(<EditableTitle name="Untitled project" onRename={vi.fn()} />);

    rerender(<EditableTitle name="Small To-do App" onRename={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Small To-do App/ })).toBeInTheDocument();
  });
});
