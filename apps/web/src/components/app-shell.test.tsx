import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "./app-shell.tsx";

/**
 * Queries go through roles and accessible names, never class names or test ids.
 *
 * Two reasons. The panes are placeholders that each get replaced wholesale by a later
 * task, and a test anchored to markup would break on contact with the real thing while
 * telling you nothing useful. And a pane that cannot be found by its accessible name is a
 * pane a screen reader cannot find either — so the assertion is worth something beyond
 * "it rendered".
 */

const PANES = ["Chat", "Preview", "Files"] as const;

describe("AppShell", () => {
  it("mounts all three panes", () => {
    render(<AppShell />);

    for (const name of PANES) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
  });

  it("gives each pane a visible heading", () => {
    // Cheap protection against a pane that mounts its landmark but renders nothing.
    render(<AppShell />);

    for (const name of PANES) {
      expect(screen.getByRole("heading", { name })).toBeVisible();
    }
  });

  it("renders exactly one main landmark", () => {
    render(<AppShell />);

    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("renders a banner identifying the product", () => {
    render(<AppShell />);

    expect(screen.getByRole("banner")).toHaveTextContent(/nap/i);
  });
});
