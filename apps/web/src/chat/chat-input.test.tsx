import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatInput } from "./chat-input.tsx";

function show(props: Partial<Parameters<typeof ChatInput>[0]> = {}) {
  return render(
    <ChatInput
      running={false}
      error={undefined}
      onSubmit={() => {}}
      onCancel={() => {}}
      {...props}
    />,
  );
}

const box = () => screen.getByRole("textbox", { name: /message/i });

function type(text: string) {
  fireEvent.change(box(), { target: { value: text } });
}

describe("sending", () => {
  it("sends what was typed", () => {
    const onSubmit = vi.fn();
    show({ onSubmit });

    type("build me a todo list");
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(onSubmit).toHaveBeenCalledWith("build me a todo list");
  });

  it("sends on Enter", () => {
    const onSubmit = vi.fn();
    show({ onSubmit });

    type("hello");
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("hello");
  });

  it("makes a newline on Shift+Enter instead", () => {
    // A prompt is often several sentences, and losing one to a stray Enter is the sort of
    // thing people stop trusting an input over.
    const onSubmit = vi.fn();
    show({ onSubmit });

    type("first line");
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("empties the box once the message is away", () => {
    show();

    type("hello");
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(box()).toHaveValue("");
  });

  it("does not send on the Enter that closes an IME candidate", () => {
    // Japanese, Chinese and Korean input use Enter to accept the suggested word. Sending there
    // posts a half-written sentence *and* eats the keystroke that was finishing it, so the
    // words are gone and the message is wrong.
    const onSubmit = vi.fn();
    show({ onSubmit });

    type("にほんご");
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("refuses to send nothing", () => {
    const onSubmit = vi.fn();
    show({ onSubmit });

    type("   ");
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("while a turn is running", () => {
  it("will not take another message", () => {
    show({ running: true });

    expect(box()).toBeDisabled();
  });

  it("offers to stop instead of to send", () => {
    // One action at a time. A Send sitting next to a Cancel invites the user to queue a
    // message the server would refuse anyway.
    show({ running: true });

    expect(screen.getByRole("button", { name: /stop/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
  });

  it("stops the turn when asked", () => {
    const onCancel = vi.fn();
    show({ running: true, onCancel });

    fireEvent.click(screen.getByRole("button", { name: /stop/i }));

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("takes messages again when the turn ends", () => {
    const { rerender } = show({ running: true });

    rerender(
      <ChatInput running={false} error={undefined} onSubmit={() => {}} onCancel={() => {}} />,
    );

    expect(box()).toBeEnabled();
    expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();
  });
});

describe("when something goes wrong", () => {
  it("says so", () => {
    show({ error: "That message didn't send. Try again." });

    expect(screen.getByRole("alert")).toHaveTextContent(/didn't send/i);
  });

  it("keeps the text so it does not have to be retyped", () => {
    // The hook rolls the optimistic message back on a failed POST; the words have to survive
    // somewhere, and the box they were typed into is the only place the user will look.
    const onSubmit = vi.fn();
    const { rerender } = show({ onSubmit });

    type("a carefully worded prompt");
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    rerender(
      <ChatInput
        running={false}
        error="That message didn't send. Try again."
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );

    expect(box()).toHaveValue("a carefully worded prompt");
  });
});
