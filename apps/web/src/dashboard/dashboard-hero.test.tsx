import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DashboardHero } from "./dashboard-hero.tsx";

/**
 * The greeting and the box under it — the one control this page exists for.
 *
 * The rim light around the box has no accessible surface and is checked by eye, not here; what
 * these assert is that the box behaves like the composer people already know from the workspace.
 */

function show(props: Partial<Parameters<typeof DashboardHero>[0]> = {}) {
  const handlers = { onChange: vi.fn(), onSubmit: vi.fn() };

  const view = render(
    <DashboardHero name="Manas" value="" busy={false} error={undefined} {...handlers} {...props} />,
  );

  return { ...handlers, view };
}

const box = () => screen.getByLabelText("Describe the app you want");

describe("the dashboard hero", () => {
  it("greets the person by name", () => {
    show();

    expect(screen.getByRole("heading", { name: /Manas/ })).toBeInTheDocument();
  });

  it("sends what was typed on Enter", () => {
    const { onSubmit } = show({ value: "a habit tracker" });

    fireEvent.keyDown(box(), { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("a habit tracker");
  });

  it("makes a newline on Shift+Enter instead", () => {
    // A prompt is usually a paragraph, and losing one to a stray Enter is what people stop
    // trusting an input over.
    const { onSubmit } = show({ value: "a habit tracker" });

    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("sends nothing that is only whitespace", () => {
    const { onSubmit } = show({ value: "   " });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("cannot be sent twice while the last one is on its way", () => {
    const { onSubmit } = show({ value: "a habit tracker", busy: true });

    fireEvent.keyDown(box(), { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("puts an example in the box rather than sending it", () => {
    // A starting point, not a decision: people edit these before sending.
    const { onChange, onSubmit } = show({ prompts: ["a habit tracker with a weekly grid"] });

    fireEvent.click(screen.getByRole("button", { name: "a habit tracker with a weekly grid" }));

    expect(onChange).toHaveBeenCalledWith("a habit tracker with a weekly grid");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("says why nothing happened when the send failed", () => {
    show({ error: "you have too many projects open" });

    expect(screen.getByRole("alert")).toHaveTextContent("you have too many projects open");
  });
});
