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

describe("the @ and / menus", () => {
  const files = ["src/App.tsx", "src/Counter.tsx", "package.json"];

  it("offers the project's real files on @", () => {
    show({ files });
    type("@Coun");

    expect(screen.getByRole("list", { name: "Files" })).toHaveTextContent("src/Counter.tsx");
  });

  it("stays shut for an email address", () => {
    show({ files });
    type("mail ada@example.com");

    expect(screen.queryByRole("list", { name: "Files" })).toBeNull();
  });

  it("puts the picked file in the box, keeping what came before", () => {
    show({ files });
    type("change the colour in @Coun");
    fireEvent.click(screen.getByRole("button", { name: /src\/Counter\.tsx/ }));

    expect(box()).toHaveValue("change the colour in @src/Counter.tsx ");
  });

  it("takes Enter while it is open, rather than sending", () => {
    // The half-typed token is not a message. Sending it would post "@Coun" and lose the
    // file the user was in the middle of naming.
    const onSubmit = vi.fn();
    show({ files, onSubmit });
    type("@Coun");
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(box()).toHaveValue("@src/Counter.tsx ");
  });

  it("walks the list with the arrow keys", () => {
    show({ files });
    type("@src");
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(box()).toHaveValue("@src/Counter.tsx ");
  });

  it("wraps to the end when walking up from the top", () => {
    // Three rows, deliberately: with two, up and down from the first row land on the same one
    // and this passes against an ArrowUp that steps forwards.
    show({ files });
    type("@");
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(box()).toHaveValue("@package.json ");
  });

  it("closes on Escape but reopens when the token changes", () => {
    // Dismissal is remembered against the text it was showing for. Remembering it as a flag
    // would keep the menu shut for the rest of the sentence.
    show({ files });
    type("@Coun");
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("list", { name: "Files" })).toBeNull();

    type("@Count");
    expect(screen.getByRole("list", { name: "Files" })).toBeInTheDocument();
  });

  it("sends normally once a mention is finished", () => {
    const onSubmit = vi.fn();
    show({ files, onSubmit });
    type("@src/App.tsx needs a header");
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("@src/App.tsx needs a header");
  });

  it("turns a slash command into the opening of a sentence", () => {
    show({ files });
    type("/fi");
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(box()).toHaveValue("Fix the ");
  });

  it("offers nothing while a turn is running", () => {
    // The field is disabled, so a menu over it could be walked with the keyboard and picked
    // into a box that cannot be typed in.
    show({ files, running: true });

    expect(screen.queryByRole("list", { name: "Files" })).toBeNull();
  });
});

describe("the model picker", () => {
  const models = [
    { id: "openai/gpt-5.6-luna", label: "Gpt 5 6 Luna", free: false, available: true },
    { id: "anthropic/claude-opus-5", label: "Claude Opus 5", free: false, available: true },
    { id: "openai/gpt-oss-20b:free", label: "Gpt Oss 20b", free: true, available: true },
  ];

  it("names the model turns will run on", () => {
    show({ models, model: "openai/gpt-5.6-luna" });

    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Gpt 5 6 Luna");
  });

  it("stays hidden when the deployment offers no choice", () => {
    // One allowed model is not a decision, and a menu with a single row implies one nobody has.
    show({ models: [models[0]!], model: models[0]!.id });

    expect(screen.queryByRole("button", { name: "Model" })).toBeNull();
  });

  it("stays hidden when the list could not be loaded at all", () => {
    // The picker is a convenience; turns run on the server's default without it. A visible
    // failure would tell somebody their app is broken because an optional control did not load.
    show({ models: [] });

    expect(screen.queryByRole("button", { name: "Model" })).toBeNull();
  });

  it("reports the model that was chosen", () => {
    const onModelChange = vi.fn();
    show({ models, model: "openai/gpt-5.6-luna", onModelChange });

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByRole("button", { name: /Claude Opus 5/ }));

    expect(onModelChange).toHaveBeenCalledWith("anthropic/claude-opus-5");
  });

  it("highlights model choices on hover", () => {
    show({ models, model: "openai/gpt-5.6-luna" });

    fireEvent.click(screen.getByRole("button", { name: "Model" }));

    expect(screen.getByRole("button", { name: /Claude Opus 5/ })).toHaveClass("hover:bg-hover");
  });

  it("says which one is running, in words rather than only in colour", () => {
    show({ models, model: "anthropic/claude-opus-5" });
    fireEvent.click(screen.getByRole("button", { name: "Model" }));

    // Which model is running decides what a turn costs, and a highlight alone is nothing to
    // somebody listening to the page.
    expect(screen.getByRole("button", { name: /Claude Opus 5/ })).toHaveTextContent("on");
  });

  it("says which ones cost nothing, in words rather than only in colour", () => {
    // The same argument as the "on" marker above, and it applies harder: price is the reason
    // somebody reaches for this menu at all, and a colour says nothing to a screen reader.
    show({ models, model: "openai/gpt-5.6-luna" });
    fireEvent.click(screen.getByRole("button", { name: "Model" }));

    expect(screen.getByRole("button", { name: /Gpt Oss 20b/ })).toHaveAccessibleName(/free/i);
    expect(screen.getByRole("button", { name: /Claude Opus 5/ })).not.toHaveAccessibleName(/free/i);
  });

  it("opens a list that is actually on the page", () => {
    // Proves the menu is rendered and populated — and **cannot** prove it is visible. The bug
    // this replaced was clipping: nested inside the `overflow-hidden` composer, the menu laid
    // out at -29px against a composer starting at 44px and was painted away entirely, with the
    // button appearing dead. jsdom has no layout, so this test passed against the broken code
    // too. The guard for the clipping itself is a measurement in a real browser.
    show({ models, model: "openai/gpt-5.6-luna" });

    expect(screen.queryByRole("list", { name: "Model" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Model" }));

    const menu = screen.getByRole("list", { name: "Model" });
    expect(menu).toBeInTheDocument();
    for (const choice of models) expect(menu).toHaveTextContent(choice.label);
  });

  it("closes when something outside it is pressed", () => {
    show({ models, model: "openai/gpt-5.6-luna" });
    fireEvent.click(screen.getByRole("button", { name: "Model" }));

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("list", { name: "Model" })).toBeNull();
  });

  it("gets out of the way when a trigger is typed", () => {
    // Two menus over one composer overlap rather than offering a choice.
    show({ models, model: "openai/gpt-5.6-luna", files: ["src/App.tsx"] });
    fireEvent.click(screen.getByRole("button", { name: "Model" }));

    type("@");

    expect(screen.queryByRole("list", { name: "Model" })).toBeNull();
    expect(screen.getByRole("list", { name: "Files" })).toBeInTheDocument();
  });

  it("cannot be changed mid-turn", () => {
    // The turn already went out on a model. Offering to change it would imply the one running
    // could be switched underneath itself.
    show({ models, model: "openai/gpt-5.6-luna", running: true });

    expect(screen.getByRole("button", { name: "Model" })).toBeDisabled();
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
