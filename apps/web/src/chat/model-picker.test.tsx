import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { modelOption } from "../testing/model-options.ts";
import { resolveEffortGlyph } from "./model-picker/effort-glyph.tsx";
import { ModelPicker } from "./model-picker.tsx";

/**
 * What a caller may run is the server's decision; this only draws it. The cases worth pinning are
 * the ones that get the *money* question wrong if they regress — a locked line must not be
 * selectable, nor named as what a message will run on — and the effort a turn is sent with.
 */

const FREE = modelOption({
  id: "openai/gpt-oss-20b:free",
  label: "Gpt Oss 20b",
  free: true,
  vendor: null,
  images: false,
  efforts: [],
});
const LINES = [
  modelOption({ id: "sol", label: "Sol", version: "openai/gpt-6.2-sol", isNew: true }),
  modelOption({ id: "luna", label: "Luna", version: "openai/gpt-6-luna" }),
  modelOption({
    id: "opus",
    label: "Opus",
    vendor: "anthropic",
    version: "anthropic/claude-opus-5.5",
  }),
  modelOption({
    id: "fable",
    label: "Fable",
    vendor: "anthropic",
    version: null,
    available: false,
  }),
  modelOption({
    id: "muse-ember",
    label: "Muse Ember",
    vendor: "meta",
    version: "meta/muse-ember",
  }),
];

function open(props: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  const handlers = {
    onChange: vi.fn(),
    onAddKey: vi.fn(),
    onEffortChange: vi.fn(),
    onPick: vi.fn(),
  };
  render(<ModelPicker models={LINES} model="sol" {...handlers} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
  return handlers;
}

const tab = (name: string) =>
  fireEvent.click(
    within(screen.getByRole("toolbar", { name: "Vendors" })).getByRole("button", { name }),
  );

describe("the trigger", () => {
  it("names the line a message will run on, with its effort in bars", () => {
    render(
      <ModelPicker
        models={LINES}
        model="opus"
        effort="high"
        onChange={vi.fn()}
        onEffortChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: /^Model/ });
    // Named for its job, described by its setting, so a screen reader hears both.
    expect(trigger).toHaveAccessibleName("Model");
    expect(trigger).toHaveAccessibleDescription("Opus 5.5, High effort");
    expect(trigger.querySelector("[data-effort-glyph]")).not.toBeNull();
  });

  it("uses the deployment label for a free model on a known line", () => {
    const free = {
      ...FREE,
      id: "openai/gpt-6.2-sol",
      version: "openai/gpt-6.2-sol",
      label: "Gpt 6.2 Sol",
    };
    render(<ModelPicker models={[free, ...LINES]} model={free.id} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Model" })).toHaveAccessibleDescription(
      "Gpt 6.2 Sol",
    );
  });

  it("follows the resolved version when the catalog or pin changes", () => {
    const { rerender } = render(<ModelPicker models={LINES} model="sol" onChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Model" });
    expect(trigger).toHaveAccessibleDescription("Sol 6.2");
    const pinned = LINES.map((line) =>
      line.id === "sol" ? { ...line, version: "openai/gpt-6.1-sol" } : line,
    );
    rerender(<ModelPicker models={pinned} model="sol" onChange={vi.fn()} />);
    expect(trigger).toHaveAccessibleDescription("Sol 6.1");
  });

  it("writes Max out rather than drawing a full row of bars", () => {
    expect(resolveEffortGlyph(["low", "medium", "high", "xhigh", "max"], "max")).toEqual({
      count: 4,
      filled: 4,
      word: "Max",
    });
    expect(resolveEffortGlyph(["low", "medium", "high", "xhigh", "max"], "medium")).toEqual({
      count: 4,
      filled: 2,
      word: null,
    });
  });

  it("never names a locked line as the one in use", () => {
    render(<ModelPicker models={LINES} model="fable" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Model/ })).toHaveTextContent("Sol 6.2");
  });
});

describe("the list", () => {
  it("opens on the vendor of the line in use, with T3's New badge", () => {
    open();
    const list = screen.getByRole("list", { name: "Model" });
    expect(list).toHaveTextContent("Sol 6.2");
    expect(list).toHaveTextContent("Luna 6");
    expect(list).not.toHaveTextContent("Opus");
    expect(within(list).getByText("New")).toHaveTextContent("New model");
    expect(screen.getByRole("button", { name: /Sol 6.2, OpenAI, in use/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("switches vendor from the rail", () => {
    open();
    tab("Meta");
    expect(screen.getByRole("list", { name: "Model" })).toHaveTextContent("Muse Ember");
  });

  it("searches every vendor at once", () => {
    open();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search models" }), {
      target: { value: "opus 5.5" },
    });
    const list = screen.getByRole("list", { name: "Model" });
    expect(list).not.toHaveTextContent("Sol 6.2");
    expect(list).toHaveTextContent("Opus 5.5");
    expect(list).not.toHaveTextContent("Muse Ember");
  });

  it("keeps a locked line listed, says why, and opens the key form instead of choosing it", () => {
    const handlers = open({
      models: LINES.map((line) => (line.id === "opus" ? { ...line, available: false } : line)),
    });
    tab("Anthropic");
    const opus = screen.getByRole("button", { name: /Opus/ });
    // Not `disabled`: that is unreachable by keyboard and unannounced.
    expect(opus).toHaveAccessibleDescription("needs your key");
    fireEvent.click(opus);
    expect(handlers.onAddKey).toHaveBeenCalled();
    expect(handlers.onChange).not.toHaveBeenCalled();
  });

  it("says a line with no working version is unavailable, rather than a key away", () => {
    open();
    tab("Anthropic");
    expect(screen.getByRole("button", { name: /Fable/ })).toHaveAccessibleDescription(
      "unavailable",
    );
  });

  it("offers the free model in its own tab, marked free and text only", () => {
    const handlers = open({
      models: [FREE, ...LINES.map((line) => ({ ...line, available: false }))],
      model: FREE.id,
    });
    const free = screen.getByRole("button", { name: /Gpt Oss 20b/ });
    expect(free).toHaveTextContent("Free");
    expect(free).toHaveTextContent("Text only");
    expect(screen.getByText("Set by this deployment")).toBeInTheDocument();
    fireEvent.click(free);
    expect(handlers.onChange).toHaveBeenCalledWith(FREE.id);
  });
});

describe("the effort column", () => {
  it("offers the line's five levels, marking the default and the one chosen", () => {
    open({ effort: "xhigh", defaultEffort: "medium" });
    expect(screen.getByText("Effort", { exact: true }).parentElement).toHaveTextContent("Sol 6.2");
    const levels = within(screen.getByRole("radiogroup", { name: "Effort" })).getAllByRole("radio");
    expect(levels.map((level) => level.textContent)).toEqual([
      "Low",
      "MediumDefault",
      "High",
      "Extra high",
      "Max",
    ]);
    expect(screen.getByRole("radio", { name: "Extra high" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("sends the level picked, and closes", async () => {
    const handlers = open();
    fireEvent.click(screen.getByRole("radio", { name: "Max" }));
    expect(handlers.onEffortChange).toHaveBeenCalledWith("max");
    expect(handlers.onPick).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("radiogroup", { name: "Effort" })).toBeNull());
  });

  it("keeps the popup open after a line is picked, so the level comes next", () => {
    const handlers = open();
    tab("Anthropic");
    fireEvent.click(screen.getByRole("button", { name: /Opus/ }));
    expect(handlers.onChange).toHaveBeenCalledWith("opus");
    expect(screen.getByRole("radiogroup", { name: "Effort" })).toBeInTheDocument();
  });

  it("is not drawn for a caller that cannot send an effort", () => {
    render(<ModelPicker models={LINES} model="sol" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
    expect(screen.queryByRole("radiogroup", { name: "Effort" })).toBeNull();
  });
});
