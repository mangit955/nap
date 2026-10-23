import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { usePanelLayout } from "./use-panel-layout.ts";
import { Workbench } from "./workbench.tsx";

function Workspace({ scope = "test" }: { scope?: string }) {
  const controller = usePanelLayout(scope);
  return (
    <>
      <button type="button" onClick={controller.toggle}>
        Toggle panel
      </button>
      <Workbench
        controller={controller}
        maximized={false}
        onMaximize={() => {}}
        preview={<input aria-label="App state" defaultValue="kept" />}
        code={<p>the files</p>}
        diff={<p>the changes</p>}
        pullRequests={<p>the pull requests</p>}
        file={(path) => <p>{path}</p>}
      />
    </>
  );
}
beforeEach(() => localStorage.clear());
describe("the right panel", () => {
  it("preserves the preview DOM across selection, tab closure, and reopening", () => {
    render(<Workspace />);
    const frame = screen.getByLabelText("App state");
    fireEvent.change(frame, { target: { value: "edited" } });
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(frame).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close Browser" }));
    fireEvent.click(screen.getByLabelText("Add panel"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Browser" }));
    expect(screen.getByLabelText("App state")).toBe(frame);
    expect(frame).toHaveValue("edited");
  });
  it("restores layout per session and repairs invalid saved state", () => {
    const { rerender, unmount } = render(<Workspace />);
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    rerender(<Workspace scope="another" />);
    expect(screen.getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true");
    rerender(<Workspace />);
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
    unmount();
    render(<Workspace />);
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
  });
  it("supports keyboard tab selection and hides the whole panel without unmounting", () => {
    render(<Workspace />);
    const browser = screen.getByRole("tab", { name: "Browser" });
    fireEvent.keyDown(browser, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Files" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Close right panel" }));
    expect(screen.getByText("the files")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Toggle panel" }));
    expect(screen.getByRole("tabpanel", { name: "Files" })).toBeVisible();
  });
});
