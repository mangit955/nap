import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ContextControl } from "./context-control.tsx";

it("offers manual compaction without inventing a usage percentage", () => {
  const compact = vi.fn();
  render(<ContextControl events={[]} running={false} onCompact={compact} />);
  fireEvent.click(screen.getByText("Context"));
  expect(screen.getByText("Usage not reported yet")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Compact context" })).toBeDisabled();
});

it("labels estimates and submits the context action", () => {
  const compact = vi.fn();
  const envelope = { sessionId: "s", turnId: "t", createdAt: "2026-10-19T00:00:00Z" };
  render(
    <ContextControl
      events={[
        { ...envelope, seq: 1, type: "agent.message", payload: { text: "Finished" } },
        {
          ...envelope,
          seq: 2,
          type: "context.usage",
          payload: {
            inputTokens: 40000,
            source: "estimated",
            budgetTokens: 80000,
            windowTokens: null,
          },
        },
      ]}
      running={false}
      onCompact={compact}
    />,
  );
  fireEvent.click(screen.getByText("Context · ~40k"));
  expect(screen.getByText(/Estimated input/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Compact context" }));
  expect(compact).toHaveBeenCalledOnce();
});
