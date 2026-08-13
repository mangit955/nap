import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ApiKeyPanel } from "./api-key-panel.tsx";

/**
 * What this component decides is when the dialog opens and closes; the form inside it is
 * tested on its own.
 *
 * **jsdom parses `<dialog>` and implements none of its methods** — `showModal` and `close` are
 * simply absent, so the effect throws on mount and every test here fails on a component that
 * is correct. The two are stubbed below to do the one observable thing the real ones do, which
 * is toggle the `open` attribute. That is enough for these assertions and is honest about the
 * limit: the parts worth having a real `<dialog>` for — the focus trap, Escape, the inert
 * backdrop — are exactly the parts no test here can see, and are why the element is used
 * rather than a `div` with `role="dialog"`.
 */
beforeAll(() => {
  const proto = globalThis.HTMLDialogElement?.prototype;
  if (proto === undefined) return;

  proto.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

function keyState(overrides: Record<string, unknown> = {}) {
  return {
    state: { configured: false } as const,
    error: undefined,
    busy: false,
    save: vi.fn(async () => true),
    remove: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as Parameters<typeof ApiKeyPanel>[0]["keyState"];
}

describe("ApiKeyPanel", () => {
  it("stays shut until it is opened", () => {
    render(<ApiKeyPanel open={false} onClose={vi.fn()} keyState={keyState()} />);

    // `showModal` is what makes a dialog modal — focus trapped, Escape wired, backdrop inert.
    // Rendering it with the `open` attribute instead looks identical and has none of that.
    expect(screen.getByRole("dialog", { hidden: true })).not.toHaveAttribute("open");
  });

  it("opens as a modal, with the form inside it", () => {
    render(<ApiKeyPanel open onClose={vi.fn()} keyState={keyState()} />);

    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByLabelText("API key")).toBeInTheDocument();
  });

  it("closes on the ✕", () => {
    const onClose = vi.fn();
    render(<ApiKeyPanel open onClose={onClose} keyState={keyState()} />);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape, which the browser fires as `close`", () => {
    const onClose = vi.fn();
    render(<ApiKeyPanel open onClose={onClose} keyState={keyState()} />);

    fireEvent(screen.getByRole("dialog"), new Event("close"));

    expect(onClose).toHaveBeenCalled();
  });

  it("brings its own ramp, since the one the form is written in is scoped elsewhere", () => {
    // Asserted by class, which this file otherwise never does, because the failure it guards
    // has no accessible surface at all: `ApiKeyForm` paints itself in `--s-*`, those variables
    // are scoped to `.ai-stage`, and this dialog opens over the workspace. Unresolved custom
    // properties are not an error — they paint nothing — so the dialog rendered transparent
    // with the page legible through its own text, and every assertion above still passed.
    render(<ApiKeyPanel open onClose={vi.fn()} keyState={keyState()} />);

    expect(screen.getByRole("dialog")).toHaveClass("ai-stage-dark");
  });

  it("saves through the shared state, so the rail's label cannot disagree with it", () => {
    const shared = keyState();
    render(<ApiKeyPanel open onClose={vi.fn()} keyState={shared} />);

    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk-or-v1-0123456789abcdef0123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    expect(shared.save).toHaveBeenCalledWith("sk-or-v1-0123456789abcdef0123");
  });
});
