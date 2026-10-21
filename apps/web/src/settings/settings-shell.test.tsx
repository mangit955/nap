import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SettingsShell } from "./settings-shell.tsx";

// jsdom parses `<dialog>` and implements none of its methods. These stand in for the two things
// the rail's key dialog relies on: `open` toggling, and focus going back to its opener.
const openers = new WeakMap<HTMLDialogElement, Element | null>();
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    openers.set(this, document.activeElement);
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    const opener = openers.get(this);
    if (opener instanceof HTMLElement) opener.focus();
    this.dispatchEvent(new Event("close"));
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Settings shell", () => {
  it("narrows the rail to matching settings and marks where the page sits", () => {
    render(
      <SettingsShell
        crumbs={[{ label: "Settings" }, { label: "Connections", href: "/c" }, { label: "GitHub" }]}
        onApiKey={() => {}}
      >
        <p>Page</p>
      </SettingsShell>,
    );
    const rail = screen.getByRole("navigation", { name: "Settings" });
    // `false` is the event having been cancelled, so the slash is not typed into the field.
    expect(fireEvent.keyDown(document.body, { key: "/" })).toBe(false);
    expect(screen.getByLabelText("Search settings")).toHaveFocus();

    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "key" } });
    expect(within(rail).queryByRole("link", { name: "Connections" })).toBeNull();
    expect(within(rail).getByRole("button", { name: "API key" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "billing" } });
    expect(within(rail).getByText("No settings match.")).toBeVisible();

    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Connections" })).toHaveAttribute("href", "/c");
    expect(within(crumbs).getByText("GitHub")).toHaveAttribute("aria-current", "page");
  });

  it("leaves `/` to a field being typed in, and to a shortcut", () => {
    render(
      <SettingsShell crumbs={[{ label: "Settings" }]} onApiKey={() => {}}>
        <input aria-label="Name" />
      </SettingsShell>,
    );
    const name = screen.getByRole("textbox", { name: "Name" });
    name.focus();
    expect(fireEvent.keyDown(name, { key: "/" })).toBe(true);
    expect(name).toHaveFocus();

    name.blur();
    expect(fireEvent.keyDown(document.body, { key: "/", metaKey: true })).toBe(true);
    expect(screen.getByLabelText("Search settings")).not.toHaveFocus();
  });

  it("leaves `/` alone when the search cannot take focus", () => {
    render(
      <SettingsShell crumbs={[{ label: "Settings" }]} onApiKey={() => {}}>
        <p>Page</p>
      </SettingsShell>,
    );
    // What a browser does below `md`, where the rail is hidden, and under a dialog, where it is inert.
    vi.spyOn(screen.getByLabelText("Search settings"), "focus").mockImplementation(() => {});
    expect(fireEvent.keyDown(document.body, { key: "/" })).toBe(true);
  });

  it("gives focus back to the rail's API key button when its dialog is closed with ✕", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    render(
      <SettingsShell crumbs={[{ label: "Settings" }]}>
        <p>Page</p>
      </SettingsShell>,
    );
    const button = screen.getByRole("button", { name: "API key" });
    button.focus();
    fireEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "Your API key" });
    const close = within(dialog).getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.click(close);
    expect(dialog).not.toHaveAttribute("open");
    expect(button).toHaveFocus();
  });
});
