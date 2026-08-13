import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiKeyForm, type ApiKeyFormProps } from "./api-key-form.tsx";

/**
 * The one rule worth pinning here is negative: nothing this form draws ever contains a key.
 * The rest is the ordinary split — every state is a prop, so none of it needs a network.
 */

const KEY = "sk-or-v1-0123456789abcdef0123";

function setup(overrides: Partial<ApiKeyFormProps> = {}) {
  const props: ApiKeyFormProps = {
    state: { configured: false },
    onSave: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
  render(<ApiKeyForm {...props} />);
  return props;
}

describe("with nothing saved", () => {
  it("takes a key and hands it over", () => {
    const props = setup();

    fireEvent.change(screen.getByLabelText("API key"), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    expect(props.onSave).toHaveBeenCalledWith(KEY);
  });

  it("masks what is typed, because it is a credential", () => {
    // A visible field is one that ends up in a screen recording and in a browser's saved-form
    // memory. One extra paste later is cheaper than either.
    setup();

    expect(screen.getByLabelText("API key")).toHaveAttribute("type", "password");
  });

  it("will not submit an empty box", () => {
    setup();

    expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
  });

  it("says where to get one, since somebody here may not have a key at all", () => {
    setup();

    expect(screen.getByRole("link", { name: "OpenRouter" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Anthropic" })).toBeInTheDocument();
  });

  it("says what the server said when a key is refused", () => {
    // An `alert`, because the field the reader just filled in has not changed and nothing else
    // on screen says the save failed.
    setup({ error: "That key was refused. Check you copied all of it." });

    expect(screen.getByRole("alert")).toHaveTextContent("That key was refused.");
  });

  it("says it is working while a key is being checked", () => {
    setup({ busy: true });

    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
  });
});

describe("with a key saved", () => {
  const saved = { configured: true, platform: "openrouter", hint: "sk-or-…0123" } as const;

  it("shows the hint and no field to read a key back from", () => {
    // There is deliberately no "show my key": the server could not answer that if it wanted to,
    // and a form that could would leak the key into every screen-share the page passes through.
    setup({ state: saved });

    expect(screen.getByText("sk-or-…0123")).toBeInTheDocument();
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  it("names the vendor, so somebody with two keys knows which is in use", () => {
    setup({ state: saved });

    expect(screen.getByText("OpenRouter")).toBeInTheDocument();
  });

  it("offers to remove it, and says what that means", () => {
    const props = setup({ state: saved });

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(props.onRemove).toHaveBeenCalled();
    expect(screen.getByText(/free models/)).toBeInTheDocument();
  });
});
