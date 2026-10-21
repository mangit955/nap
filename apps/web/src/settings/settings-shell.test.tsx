import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsShell } from "./settings-shell.tsx";

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
    fireEvent.keyDown(window, { key: "/" });
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
});
