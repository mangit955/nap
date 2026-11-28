import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Command } from "./commands.ts";
import { CommandRegistryContext, createCommandRegistry, useCommands } from "./registry.ts";

const command = (id: string, run: () => void = () => {}): Command => ({
  id,
  group: "Actions",
  order: 0,
  label: id,
  icon: null,
  run,
});

function Offers({ id, run }: { id: string; run?: () => void }) {
  useCommands(() => [command(id, run)]);
  return null;
}

describe("useCommands", () => {
  it("offers its commands while mounted and takes them back when it unmounts", () => {
    const registry = createCommandRegistry();
    const view = render(
      <CommandRegistryContext.Provider value={registry}>
        <Offers id="files" />
      </CommandRegistryContext.Provider>,
    );
    expect(registry.list().map((item) => item.id)).toEqual(["files"]);
    view.rerender(<CommandRegistryContext.Provider value={registry} />);
    expect(registry.list()).toEqual([]);
  });

  it("hands over the latest render's handler, and says so to whoever listens", () => {
    const registry = createCommandRegistry();
    const heard = vi.fn();
    registry.subscribe(heard);
    const first = vi.fn();
    const second = vi.fn();
    const view = render(
      <CommandRegistryContext.Provider value={registry}>
        <Offers id="files" run={first} />
      </CommandRegistryContext.Provider>,
    );
    heard.mockClear();
    view.rerender(
      <CommandRegistryContext.Provider value={registry}>
        <Offers id="files" run={second} />
      </CommandRegistryContext.Provider>,
    );
    expect(heard).toHaveBeenCalled();
    act(() => registry.list()[0]?.run());
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it("does nothing outside a palette", () => {
    expect(() => render(<Offers id="files" />)).not.toThrow();
  });
});
