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

  it("refuses to send nothing", () => {
    const onSubmit = vi.fn();
    show({ onSubmit });

    type("   ");
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("while a turn is running", () => {
  it("gives the box over to the working indicator", () => {
    // Not merely disabled: a two-row box that can do nothing is the largest thing in the
    // footer and it says less than the label that replaces it.
    show({ running: true, label: "Running bun install" });

    expect(screen.queryByRole("textbox", { name: /message/i })).toBeNull();
    expect(screen.getByRole("status", { name: "Agent is working" })).toBeInTheDocument();
  });

  it("says what the agent is doing, and for how long", () => {
    const startedAt = new Date(Date.now() - 8000).toISOString();
    const { container } = show({ running: true, label: "Writing Counter.tsx", startedAt });

    expect(container.textContent).toContain("Writing Counter.tsx");
    expect(container.textContent).toMatch(/\ds/);
  });

  it("keeps the words that were in the box", () => {
    // The box unmounts while the turn runs, so anything typed into it lives or dies by where
    // the state is held. A retry or a prompt carried in from the front page both start a turn
    // without the box having been cleared.
    const { rerender } = show();
    type("a carefully worded prompt");

    rerender(
      <ChatInput running={true} error={undefined} onSubmit={() => {}} onCancel={() => {}} />,
    );
    rerender(
      <ChatInput running={false} error={undefined} onSubmit={() => {}} onCancel={() => {}} />,
    );

    expect(box()).toHaveValue("a carefully worded prompt");
  });

  it("gives the box back the focus it took", () => {
    // Enter sends, so the box is usually focused at the moment it disappears — and focus
    // falling to the document body means the next message begins with a hunt for the cursor.
    const { rerender } = show();
    box().focus();

    rerender(
      <ChatInput running={true} error={undefined} onSubmit={() => {}} onCancel={() => {}} />,
    );
    rerender(
      <ChatInput running={false} error={undefined} onSubmit={() => {}} onCancel={() => {}} />,
    );

    expect(box()).toHaveFocus();
  });

  it("leaves the focus alone when it was somewhere else", () => {
    // The counterpart, and the one that matters: a turn ending while somebody is reading the
    // file tree must not yank the cursor back to the chat box. Without this case, the test
    // above passes against code that simply focuses on every turn end.
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);

    const { rerender } = show({ running: true });
    elsewhere.focus();

    rerender(
      <ChatInput running={false} error={undefined} onSubmit={() => {}} onCancel={() => {}} />,
    );

    expect(elsewhere).toHaveFocus();
    elsewhere.remove();
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
