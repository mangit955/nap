import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Features } from "./features.tsx";

describe("the feature inspector", () => {
  it("lets visitors inspect files, a change, and saved history", () => {
    render(<Features />);
    const panel = () => within(screen.getByRole("tabpanel"));
    expect(panel().getByText("App.tsx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    expect(panel().getByText(/<Dashboard/)).toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Changes");
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(panel().getByText("Checkpoint saved")).toBeInTheDocument();
    expect(panel().getByText("8f2c6a1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(panel().getByText("package.json")).toBeInTheDocument();
  });

  it("moves keyboard focus and selection together", () => {
    render(<Features />);
    const files = screen.getByRole("tab", { name: "Files" });
    files.focus();
    fireEvent.keyDown(files, { key: "ArrowRight" });
    const changes = screen.getByRole("tab", { name: "Changes" });
    expect(changes).toHaveFocus();
    expect(changes).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(changes, { key: "End" });
    const history = screen.getByRole("tab", { name: "History" });
    expect(history).toHaveFocus();
    fireEvent.keyDown(history, { key: "Home" });
    expect(files).toHaveFocus();
  });

  it("replays the feature scenes and returns the inspector to its first view", () => {
    render(<Features />);
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: "Replay animations" }));
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
    expect(within(screen.getByRole("tabpanel")).getByText("App.tsx")).toBeInTheDocument();
  });
});
