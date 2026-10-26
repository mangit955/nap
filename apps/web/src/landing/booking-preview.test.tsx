import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BookingPreview } from "./booking-preview.tsx";

describe("the interactive booking example", () => {
  it("carries the selected dates and price through confirmation and back", () => {
    render(<BookingPreview />);
    expect(screen.getByText(/\$390 total/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Arrive November 9" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Length of stay" }), {
      target: { value: "4" },
    });
    expect(screen.getByText(/\$780 total/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /reserve your quiet/i }));
    expect(screen.getByRole("status")).toHaveTextContent("November 9 to 13 · 4 nights");
    expect(screen.getByRole("status")).toHaveTextContent("$780 total");
    expect(screen.getByRole("status")).toHaveTextContent("No reservation is created.");
    fireEvent.click(screen.getByRole("button", { name: /choose another stay/i }));
    expect(screen.getByRole("button", { name: "Arrive November 9" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("combobox")).toHaveValue("4");
  });
});
