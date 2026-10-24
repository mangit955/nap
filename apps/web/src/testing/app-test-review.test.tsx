import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { AppTestReview } from "./app-test-review.tsx";

it("drives the live pane's app-test admission and explicit repair with an in-memory server", async () => {
  render(<AppTestReview />);
  const button = await screen.findByRole("button", { name: "Test the app" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() =>
    expect(screen.getByRole("status", { name: "Review requests" })).toHaveTextContent("/tests"),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Review test state" }), {
    target: { value: "failed" },
  });
  const fix = await screen.findByRole("button", { name: "Fix it" });
  fireEvent.click(fix);
  await waitFor(() =>
    expect(screen.getByRole("status", { name: "Review requests" })).toHaveTextContent("/turns"),
  );
});
