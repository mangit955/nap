import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceHeader } from "./workspace-header.tsx";

/**
 * The one bar across the top: what project this is, which half of the workbench is showing, and
 * the controls that belong to the running app.
 *
 * Everything here is queried by role and accessible name — a bar of icon buttons is exactly
 * where an unlabelled control hides, and it is the failure worth catching.
 */

function show(props: Partial<Parameters<typeof WorkspaceHeader>[0]> = {}) {
  const handlers = {
    onTabChange: vi.fn(),
    onReload: vi.fn(),
    onRouteChange: vi.fn(),
    onToggleChat: vi.fn(),
  };

  render(
    <WorkspaceHeader
      projectName="Todo app"
      tab="preview"
      chatOpen={true}
      route="/"
      previewUrl="https://5173-abc.e2b.app"
      {...handlers}
      {...props}
    />,
  );

  return handlers;
}

describe("the workbench tabs", () => {
  it("offers both halves, and says which is showing", () => {
    show({ tab: "code" });

    expect(screen.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "false");
  });

  it("switches when one is pressed", () => {
    const { onTabChange } = show();

    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    expect(onTabChange).toHaveBeenCalledWith("code");
  });
});

describe("the app's own controls", () => {
  it("reloads the frame", () => {
    const { onReload } = show();

    fireEvent.click(screen.getByRole("button", { name: /reload/i }));

    expect(onReload).toHaveBeenCalled();
  });

  it("opens the running app in a tab of its own, at the page being shown", () => {
    show({ route: "/pricing" });

    const open = screen.getByRole("link", { name: /open/i });
    expect(open).toHaveAttribute("href", "https://5173-abc.e2b.app/pricing");
    // A model wrote what is inside that frame; it does not get this page's window.
    expect(open).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("sends the frame to the page that was typed, tidied up", () => {
    const { onRouteChange } = show();

    fireEvent.change(screen.getByLabelText(/page/i), { target: { value: "pricing" } });
    fireEvent.submit(screen.getByLabelText(/page/i).closest("form") as HTMLFormElement);

    expect(onRouteChange).toHaveBeenCalledWith("/pricing");
  });

  it("offers nothing to reload or open before there is an app", () => {
    // A dead link to a sandbox that does not exist is worse than no link: it opens the
    // provider's not-found page, which reads as the product being broken.
    show({ previewUrl: undefined });

    expect(screen.queryByRole("button", { name: /reload/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /open/i })).toBeNull();
  });
});

describe("the chat toggle", () => {
  it("says what it will do, not what is showing", () => {
    const { onToggleChat } = show({ chatOpen: true });

    const toggle = screen.getByRole("button", { name: /hide chat/i });
    fireEvent.click(toggle);

    expect(onToggleChat).toHaveBeenCalled();
  });

  it("offers the way back once the chat is hidden", () => {
    show({ chatOpen: false });

    expect(screen.getByRole("button", { name: /show chat/i })).toBeInTheDocument();
  });
});
