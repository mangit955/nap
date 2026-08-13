import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./model-picker.tsx";

/**
 * What a caller may run is the server's decision; this only draws it. The cases worth pinning
 * are the two that get the *money* question wrong if they regress: a locked model must not be
 * selectable, and a locked model must not be what the composer says a message will run on.
 */

const MODELS = [
  { id: "openai/gpt-5.6-luna", label: "Gpt 5.6 Luna", free: false, available: false },
  { id: "anthropic/claude-opus-5", label: "Claude Opus 5", free: false, available: false },
  { id: "openai/gpt-oss-20b:free", label: "Gpt Oss 20b", free: true, available: true },
];

function open(props: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  const handlers = { onChange: vi.fn(), onAddKey: vi.fn() };
  render(<ModelPicker models={MODELS} model={undefined} {...handlers} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  return handlers;
}

describe("a model this caller cannot reach", () => {
  it("is still listed, so nobody has to guess the product is smaller than it is", () => {
    open();

    expect(screen.getByRole("button", { name: /Claude Opus 5/ })).toBeInTheDocument();
  });

  it("says why, in words a screen reader reaches", () => {
    // Deliberately not a `disabled` button: that is unreachable by keyboard and unannounced,
    // so the one explanation would be visible only to people using a mouse and eyes.
    open();

    expect(screen.getByRole("button", { name: /Claude Opus 5/ })).toHaveAccessibleDescription(
      "needs your key",
    );
  });

  it("opens the key form instead of being chosen", () => {
    const handlers = open();

    fireEvent.click(screen.getByRole("button", { name: /Claude Opus 5/ }));

    expect(handlers.onAddKey).toHaveBeenCalled();
    // The half that matters: picking it must not set it as the model, or the next message is
    // sent on a model the server will refuse.
    expect(handlers.onChange).not.toHaveBeenCalled();
  });
});

describe("what the composer says it will run on", () => {
  it("falls back to the first model this caller can actually reach", () => {
    // Not the first *listed* one. The allowlist opens with a paid model, so a free caller
    // would otherwise see "Gpt 5.6 Luna" on the composer and have every message refused.
    render(<ModelPicker models={MODELS} model={undefined} onChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Gpt Oss 20b");
  });

  it("honours an explicit choice", () => {
    const reachable = MODELS.map((model) => ({ ...model, available: true }));
    render(<ModelPicker models={reachable} model="anthropic/claude-opus-5" onChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude Opus 5");
  });

  it("chooses a reachable model when one is picked", () => {
    const handlers = open();

    fireEvent.click(screen.getByRole("button", { name: /Gpt Oss 20b/ }));

    expect(handlers.onChange).toHaveBeenCalledWith("openai/gpt-oss-20b:free");
  });
});
