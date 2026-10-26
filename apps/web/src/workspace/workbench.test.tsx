import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PANEL_LAYOUT } from "./tabs.ts";
import { usePanelLayout } from "./use-panel-layout.ts";
import { Workbench } from "./workbench.tsx";

function Workspace({
  scope = "test",
  narrow = false,
  computerAvailable = true,
}: {
  scope?: string;
  narrow?: boolean;
  computerAvailable?: boolean;
}) {
  const controller = usePanelLayout(scope);
  return (
    <>
      <button type="button" onClick={controller.toggle}>
        Toggle panel
      </button>
      <button type="button" onClick={() => controller.close("code")}>
        Close Files externally
      </button>
      <Workbench
        controller={controller}
        narrow={narrow}
        maximized={false}
        onMaximize={() => {}}
        computer={computerAvailable ? <p>the computer</p> : undefined}
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
  it.each([false, true])(
    "omits unavailable Computer from the panel menu with narrow=%s",
    (narrow) => {
      render(<Workspace narrow={narrow} computerAvailable={false} />);
      fireEvent.click(screen.getByLabelText("Add panel"));
      expect(screen.queryByRole("menuitem", { name: "Computer" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("menuitem", { name: "Files" }));
      expect(screen.getByRole("tabpanel", { name: "Files" })).toBeVisible();
    },
  );

  it.each([false, true])(
    "omits unavailable Computer from the empty launcher with narrow=%s",
    (narrow) => {
      localStorage.setItem(
        "nap.right-panel.v1:test",
        JSON.stringify({ ...DEFAULT_PANEL_LAYOUT, tabs: [], active: null }),
      );
      render(<Workspace narrow={narrow} computerAvailable={false} />);
      expect(screen.queryByRole("button", { name: "Computer" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Browser" }));
      expect(screen.getByRole("tabpanel", { name: "Browser" })).toBeVisible();
    },
  );

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
  it("restores layout per session", () => {
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
  it.each([
    ["Browser", "ArrowRight", ["Files", "Browser"]],
    ["Files", "ArrowLeft", ["Files", "Browser"]],
  ] as const)("reorders %s with Alt+%s and persists the order", (name, key, order) => {
    const { unmount } = render(<Workspace />);
    const tab = screen.getByRole("tab", { name });
    fireEvent.click(tab);
    tab.focus();
    fireEvent.keyDown(tab, { key, altKey: true });
    expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual(order);
    expect(tab).toHaveFocus();
    expect(tab).toHaveAttribute("aria-selected", "true");
    unmount();
    render(<Workspace />);
    expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual(order);
    expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
  });
  it.each([
    ["Browser", "ArrowLeft"],
    ["Files", "ArrowRight"],
  ] as const)("keeps %s in place when Alt+%s reaches the boundary", (name, key) => {
    render(<Workspace />);
    const tab = screen.getByRole("tab", { name });
    fireEvent.click(tab);
    tab.focus();
    fireEvent.keyDown(tab, { key, altKey: true });
    expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual([
      "Browser",
      "Files",
    ]);
    expect(tab).toHaveFocus();
    expect(tab).toHaveAttribute("aria-selected", "true");
  });
  it("wraps ordinary arrow selection and supports Home and End without reordering", () => {
    render(<Workspace />);
    const browser = screen.getByRole("tab", { name: "Browser" });
    const files = screen.getByRole("tab", { name: "Files" });
    browser.focus();
    fireEvent.keyDown(browser, { key: "ArrowLeft" });
    expect(files).toHaveFocus();
    fireEvent.keyDown(files, { key: "ArrowRight" });
    expect(browser).toHaveFocus();
    fireEvent.keyDown(browser, { key: "End" });
    expect(files).toHaveFocus();
    fireEvent.keyDown(files, { key: "Home" });
    expect(browser).toHaveFocus();
    expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual([
      "Browser",
      "Files",
    ]);
  });
  it("drags the first tab to the last position and restores that order", () => {
    const { unmount } = render(<Workspace />);
    fireEvent.click(screen.getByLabelText("Add panel"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Diff" }));
    const browser = screen.getByRole("tab", { name: "Browser" });
    fireEvent.click(browser);
    browser.focus();
    const dataTransfer = { setData: vi.fn(), effectAllowed: "none" };
    fireEvent.dragStart(browser, { dataTransfer });
    fireEvent.dragOver(screen.getByRole("tab", { name: "Diff" }), { dataTransfer });
    fireEvent.drop(screen.getByRole("tab", { name: "Diff" }), { dataTransfer });
    expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual([
      "Files",
      "Diff",
      "Browser",
    ]);
    expect(browser).toHaveAttribute("aria-selected", "true");
    expect(browser).toHaveFocus();
    unmount();
    render(<Workspace />);
    expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual([
      "Files",
      "Diff",
      "Browser",
    ]);
  });
  it("hands focus to the selected replacement after deleting the active tab", () => {
    render(<Workspace />);
    const browser = screen.getByRole("tab", { name: "Browser" });
    browser.focus();
    fireEvent.keyDown(browser, { key: "Delete" });
    const files = screen.getByRole("tab", { name: "Files" });
    expect(screen.queryByRole("tab", { name: "Browser" })).not.toBeInTheDocument();
    expect(files).toHaveAttribute("aria-selected", "true");
    expect(files).toHaveFocus();
  });
  it("returns focus from a removed close button to the surviving tab", () => {
    render(<Workspace />);
    const close = screen.getByRole("button", { name: "Close Browser" });
    close.focus();
    fireEvent.click(close);
    expect(screen.getByRole("tab", { name: "Files" })).toHaveFocus();
  });
  it("returns focus to the active tab when the focused inactive tab is deleted", () => {
    render(<Workspace />);
    const files = screen.getByRole("tab", { name: "Files" });
    files.focus();
    fireEvent.keyDown(files, { key: "Delete" });
    const browser = screen.getByRole("tab", { name: "Browser" });
    expect(browser).toHaveAttribute("aria-selected", "true");
    expect(browser).toHaveFocus();
  });
  it("hands focus to Add panel after deleting the last tab", () => {
    render(<Workspace />);
    fireEvent.click(screen.getByRole("button", { name: "Close Files" }));
    const browser = screen.getByRole("tab", { name: "Browser" });
    browser.focus();
    fireEvent.keyDown(browser, { key: "Delete" });
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByLabelText("Add panel")).toHaveFocus();
  });
  it.each([
    ["Close tab", "Files"],
    ["Close other tabs", "Browser"],
    ["Close all tabs", null],
  ] as const)("restores focus after the context action %s", (action, survivor) => {
    render(<Workspace />);
    const browser = screen.getByRole("tab", { name: "Browser" });
    browser.focus();
    fireEvent.keyDown(browser, { key: "F10", shiftKey: true });
    const item = screen.getByRole("menuitem", { name: action });
    item.focus();
    fireEvent.click(item);
    expect(screen.queryByRole("menu", { name: "Tab actions" })).not.toBeInTheDocument();
    expect(
      survivor ? screen.getByRole("tab", { name: survivor }) : screen.getByLabelText("Add panel"),
    ).toHaveFocus();
  });
  it("does not steal focus from an unrelated control when an active tab closes", () => {
    render(<Workspace />);
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    const external = screen.getByRole("button", { name: "Close Files externally" });
    external.focus();
    fireEvent.click(external);
    expect(screen.getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true");
    expect(external).toHaveFocus();
  });
  it.each([
    "{broken",
    JSON.stringify({ ...DEFAULT_PANEL_LAYOUT, version: 99 }),
    JSON.stringify({ ...DEFAULT_PANEL_LAYOUT, tabs: [{ kind: "file", path: "../secret" }] }),
  ])("repairs malformed saved layout %s before persisting it", (raw) => {
    localStorage.setItem("nap.right-panel.v1:test", raw);
    render(<Workspace />);
    expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual([
      "Browser",
      "Files",
    ]);
    expect(screen.getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true");
    expect(JSON.parse(localStorage.getItem("nap.right-panel.v1:test") ?? "null")).toEqual(
      DEFAULT_PANEL_LAYOUT,
    );
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

  it("moves focus into the native narrow panel, contains it, and restores its opener on close", () => {
    localStorage.setItem(
      "nap.right-panel.v1:test",
      JSON.stringify({ ...DEFAULT_PANEL_LAYOUT, open: false }),
    );
    render(<Workspace narrow />);
    const opener = screen.getByRole("button", { name: "Toggle panel" });
    opener.focus();
    fireEvent.click(opener);

    expect(screen.getByRole("dialog", { name: "Right panel" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    const browser = screen.getByRole("tab", { name: "Browser" });
    expect(browser).toHaveFocus();
    screen.getByRole("button", { name: "Close Files externally" }).focus();
    expect(browser).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Close right panel" }));
    expect(screen.queryByRole("dialog", { name: "Right panel" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("wraps Tab at both ends of the native narrow panel", () => {
    const rects = vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue(
      Object.assign([new DOMRect(0, 0, 100, 30)], {
        item: () => new DOMRect(0, 0, 100, 30),
      }),
    );
    try {
      render(<Workspace narrow />);
      const first = screen.getByRole("tab", { name: "Browser" });
      const last = screen.getByRole("textbox", { name: "App state" });
      first.focus();
      fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
      expect(last).toHaveFocus();
      fireEvent.keyDown(last, { key: "Tab" });
      expect(first).toHaveFocus();
    } finally {
      rects.mockRestore();
    }
  });
});

it("opens and persists the Computer tab from the panel menu", () => {
  const view = render(<Workspace />);
  fireEvent.click(screen.getByLabelText("Add panel"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Computer" }));
  expect(screen.getByRole("tab", { name: "Computer" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("the computer")).toBeVisible();
  view.unmount();
  render(<Workspace />);
  expect(screen.getByRole("tab", { name: "Computer" })).toHaveAttribute("aria-selected", "true");
});
