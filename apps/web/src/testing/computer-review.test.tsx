import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ComputerReview } from "./computer-review.tsx";

it("renders the real Computer pane and tab without authentication or a network turn", () => {
  render(<ComputerReview />);
  expect(screen.getByRole("tab", { name: "Computer" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("application", { name: "Remote computer" })).toBeInTheDocument();
});
