import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./app-shell.tsx";

/**
 * Queries go through roles and accessible names, never class names or test ids.
 *
 * That matters more here than usual now that the panes have no visible headings: the workbench
 * says which half is showing with a tab, and the chat's own name exists only for a reader. A
 * region nobody can name is a region a screen reader cannot find, and with the title bars gone
 * these assertions are the only thing keeping those names alive.
 */

const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";

/**
 * The shell asks the server which project it is showing, so every case here needs an answer to
 * that question. A pending fetch is the honest default: it is what the first frame really is.
 */
beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
});

describe("AppShell", () => {
  it("mounts the chat beside the workbench", () => {
    render(<AppShell projectId={PROJECT} />);

    expect(screen.getByRole("region", { name: "Chat" })).toBeInTheDocument();
    expect(screen.getByRole("tabpanel", { name: "Preview" })).toBeInTheDocument();
  });

  it("offers both halves of the workbench, with the preview showing first", () => {
    // The preview is what somebody came to watch; the code is what they go looking for.
    render(<AppShell projectId={PROJECT} />);

    expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "false");
  });

  it("shows the code when its tab is pressed", () => {
    render(<AppShell projectId={PROJECT} />);

    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    expect(screen.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "Files" })).toBeVisible();
  });

  it("gives the whole window to the workbench when the chat is hidden", () => {
    render(<AppShell projectId={PROJECT} />);

    fireEvent.click(screen.getByRole("button", { name: /hide chat/i }));

    expect(screen.queryByRole("region", { name: "Chat" })).toBeNull();
    expect(screen.getByRole("button", { name: /show chat/i })).toBeInTheDocument();
  });

  it("lets the divider be moved without a mouse", () => {
    // A drag handle that only answers a pointer is unreachable for anybody who does not use
    // one, and this one decides how much of the screen the transcript gets.
    render(<AppShell projectId={PROJECT} />);

    const divider = screen.getByRole("separator", { name: /chat width/i });
    const before = Number(divider.getAttribute("aria-valuenow"));

    fireEvent.keyDown(divider, { key: "ArrowRight" });

    expect(Number(divider.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
  });

  it("renders exactly one main landmark", () => {
    render(<AppShell projectId={PROJECT} />);

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
