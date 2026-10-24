import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ComputerReview } from "./computer-review.tsx";

it("renders the real Computer pane and tab without authentication or a network turn", () => {
  render(<ComputerReview />);
  expect(screen.getByRole("tab", { name: "Computer" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("application", { name: "Remote computer" })).toBeInTheDocument();
});

it("seeks the pane from the actual work log and screenshot card", () => {
  render(<ComputerReview />);
  fireEvent.change(screen.getByRole("combobox", { name: "Review state" }), {
    target: { value: "work log" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Used computer - 2 actions" }));
  expect(screen.getByRole("slider", { name: "Session timeline" })).toHaveValue("3");
  expect(screen.getByRole("button", { name: "Typed text" })).toBeInTheDocument();
  expect(screen.queryByText(/fixture-secret/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open computer screenshot" })).toBeInTheDocument();
});
