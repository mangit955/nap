import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { AppPreview } from "./app-preview.tsx";

it("updates the example app's balance and chart when changing period", () => {
  render(<AppPreview />);
  fireEvent.click(screen.getByRole("button", { name: "Year" }));
  expect(screen.getByText("$48,260.80")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Balance trend for this year" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Month" }));
  expect(screen.getByText("$12,684.50")).toBeInTheDocument();
});
