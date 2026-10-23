import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ContextControl } from "./context-control.tsx";

it("offers manual compaction without inventing a usage percentage", () => {
  const compact = vi.fn();
  render(<ContextControl events={[]} running={false} onCompact={compact} />);
  fireEvent.click(screen.getByLabelText("Context, usage not reported"));
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
  fireEvent.click(screen.getByLabelText("Context, estimated 50% of Nap input budget"));
  expect(screen.getByText(/Estimated input/)).toBeTruthy();
  expect(screen.getByText("50% · ~40k/80k")).toBeVisible();
  expect(screen.getByLabelText("Context, estimated 50% of Nap input budget").textContent).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Compact context" }));
  expect(compact).toHaveBeenCalledOnce();
});

it("names the input budget denominator and closes with Escape, returning focus", () => {
  const envelope = { sessionId: "s", turnId: "t", createdAt: "2026-10-19T00:00:00Z" };
  render(
    <ContextControl
      events={[
        { ...envelope, seq: 1, type: "agent.message", payload: { text: "Done" } },
        {
          ...envelope,
          seq: 2,
          type: "context.usage",
          payload: {
            inputTokens: 90000,
            budgetTokens: 80000,
            windowTokens: 200000,
            source: "reported",
          },
        },
      ]}
      running={false}
      onCompact={vi.fn()}
    />,
  );
  const trigger = screen.getByLabelText("Context, reported 113% of Nap input budget");
  expect(trigger).not.toBeNull();
  if (!trigger) return;
  fireEvent.click(trigger);
  expect(screen.getByText("113% · 90k/80k")).toBeVisible();
  expect(screen.getByRole("progressbar", { name: "Nap input budget usage" })).toHaveAttribute(
    "aria-valuenow",
    "100",
  );
  expect(screen.getByText(/Last reported input/)).toBeVisible();
  const action = screen.getByRole("button", { name: "Compact context" });
  action.focus();
  fireEvent.keyDown(action, { key: "Escape" });
  expect(trigger.closest("details")).not.toHaveAttribute("open");
  expect(trigger).toHaveFocus();
});

it("explains a disabled action and dismisses the popup on an outside press", () => {
  render(<ContextControl events={[]} running onCompact={vi.fn()} />);
  const trigger = screen.getByLabelText("Context, usage not reported");
  fireEvent.click(trigger);
  expect(screen.getByText("Available when the current operation finishes.")).toBeVisible();
  expect(screen.queryByRole("progressbar")).toBeNull();
  fireEvent.pointerDown(document.body);
  expect(trigger.closest("details")).not.toHaveAttribute("open");
});

it("allows compaction of known history even when usage is unknown", () => {
  render(
    <ContextControl
      events={[
        {
          sessionId: "s",
          turnId: "t",
          seq: 1,
          createdAt: "2026-10-20T00:00:00Z",
          type: "agent.message",
          payload: { text: "Done" },
        },
      ]}
      running={false}
      onCompact={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByLabelText("Context, usage not reported"));
  expect(screen.getByRole("button", { name: "Compact context" })).toBeEnabled();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByText(/0%/)).toBeNull();
});

it("fits the popup above its anchor inside the clipping pane as the composer grows", () => {
  render(
    <section aria-label="Chat pane" style={{ overflowY: "hidden" }}>
      <ContextControl events={[]} running={false} onCompact={vi.fn()} />
    </section>,
  );
  const pane = screen.getByRole("region", { name: "Chat pane" });
  const trigger = screen.getByLabelText("Context, usage not reported").closest("summary");
  const details = trigger?.closest("details");
  if (!trigger || !details) throw new Error("Missing disclosure");
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 80, 390, 420));
  const anchor = vi
    .spyOn(details, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(16, 234, 358, 36));
  fireEvent.click(trigger);
  fireEvent(details, new Event("toggle"));
  const popup = screen.getByRole("button", { name: "Compact context" }).parentElement;
  expect(popup).toHaveStyle({ maxHeight: "150px" });
  anchor.mockReturnValue(new DOMRect(16, 180, 358, 36));
  fireEvent(window, new Event("resize"));
  expect(popup).toHaveStyle({ maxHeight: "96px" });
  trigger.focus();
  const action = screen.getByRole("button", { name: "Compact context" });
  action.focus();
  expect(details).toHaveAttribute("open");
  fireEvent.keyDown(action, { key: "Escape" });
  expect(trigger).toHaveFocus();
  expect(details).not.toHaveAttribute("open");
});

it("says which model's context compacts on its own, and says it without one", () => {
  const { unmount } = render(
    <ContextControl events={[]} running={false} modelLabel="Gpt 5.6 Luna" onCompact={vi.fn()} />,
  );
  fireEvent.click(screen.getByLabelText("Context, usage not reported"));
  expect(
    screen.getByText("Context for Gpt 5.6 Luna compacts automatically when needed."),
  ).toBeVisible();
  unmount();

  render(<ContextControl events={[]} running={false} onCompact={vi.fn()} />);
  fireEvent.click(screen.getByLabelText("Context, usage not reported"));
  expect(screen.getByText("Context compacts automatically when needed.")).toBeVisible();
});
