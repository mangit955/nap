import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";

/**
 * The shell asks the server which project it is showing, so every case here needs an answer to
 * that question. A pending fetch is the honest default: it is what the first frame really is.
 */
beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
});

describe("AppShell", () => {
  it("mounts all three panes", () => {
    render(<AppShell projectId={PROJECT} />);

    for (const name of PANES) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
  });

  it("gives each pane a visible heading", () => {
    // Cheap protection against a pane that mounts its landmark but renders nothing.
    render(<AppShell projectId={PROJECT} />);

    for (const name of PANES) {
      expect(screen.getByRole("heading", { name })).toBeVisible();
    }
  });

  it("renders exactly one main landmark", () => {
    render(<AppShell projectId={PROJECT} />);

    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("renders a banner identifying the product", () => {
    render(<AppShell projectId={PROJECT} />);

    expect(screen.getByRole("banner")).toHaveTextContent(/nap/i);
  });

  it("offers a way back to the dashboard", () => {
    // Without it the workspace is a dead end: the URL is the only route out, and nobody types
    // one to leave a page.
    render(<AppShell projectId={PROJECT} />);

    expect(screen.getByRole("link", { name: /nap/i })).toHaveAttribute("href", "/dashboard");
  });
});
