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

  it("gives each row one heading and a link to how it works", () => {
    render(<Features />);
    const rows = screen.getAllByRole("article");
    expect(rows.map((row) => within(row).getByRole("heading", { level: 2 }).textContent)).toEqual([
      "It keeps working after you close the tab.",
      "It checks its own work.",
      "The code is yours.",
    ]);
    expect(rows.map((row) => within(row).getByRole("link").getAttribute("href"))).toEqual([
      "/docs#durable-jobs",
      "/docs#verification",
      "/sign-up",
    ]);
  });
});
