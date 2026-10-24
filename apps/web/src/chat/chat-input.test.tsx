import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ComposerDraft, ComposerDraftStore } from "../projects/composer-draft.ts";
import * as draftNavigation from "../projects/use-draft-navigation.ts";
import { mediaBrowser } from "../testing/media-browser.ts";
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

it("stops dictation when chat is hidden and retains the draft when shown again", () => {
  const stop = vi.fn();
  vi.stubGlobal(
    "SpeechRecognition",
    class {
      start = vi.fn();
      stop = stop;
      abort = vi.fn();
    },
  );
  const props = { running: false, error: undefined, onSubmit: vi.fn(), onCancel: vi.fn() };
  const view = render(<ChatInput {...props} />);
  try {
    type("Keep this draft");
    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    expect(screen.getByRole("button", { name: "Stop dictation" })).toBeInTheDocument();
    view.rerender(<ChatInput {...props} visible={false} />);
    expect(stop).toHaveBeenCalledOnce();
    view.rerender(<ChatInput {...props} visible />);
    expect(box()).toHaveValue("Keep this draft");
    expect(screen.getByRole("button", { name: "Start dictation" })).toBeInTheDocument();
  } finally {
    view.unmount();
    vi.unstubAllGlobals();
  }
});

describe("reference inputs", () => {
  let browser: ReturnType<typeof mediaBrowser>;
  beforeEach(() => {
    browser = mediaBrowser();
  });
  afterEach(() => {
    browser.restore();
  });
  const models = [
    { id: "openai/gpt-5.6-luna", label: "Luna", free: false, available: true },
    {
      id: "nvidia/nemotron-3-ultra-550b-a55b:free",
      label: "Nemotron",
      free: true,
      available: true,
    },
  ];

  it.each(["picker", "paste", "drop"])(
    "sends the prepared image from %s through the same submission",
    async (source) => {
      const onSubmit = vi.fn();
      show({ onSubmit, models, model: "openai/gpt-5.6-luna" });
      const files = [new File(["small"], "reference.png", { type: "image/png" })];
      if (source === "picker")
        fireEvent.change(screen.getByLabelText("Attach images or videos"), { target: { files } });
      else if (source === "paste") fireEvent.paste(box(), { clipboardData: { files } });
      else
        fireEvent.drop(screen.getByRole("group", { name: "Message composer" }), {
          dataTransfer: { files },
        });
      await screen.findByRole("button", { name: "Remove reference.png" });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      expect(onSubmit).toHaveBeenCalledWith("Use these references for the app.", [
        {
          kind: "image",
          name: "reference.png",
          frames: [{ mediaType: "image/jpeg", data: "/9j/AAAA", timestamp: 0 }],
        },
      ]);
    },
  );

  it("does not offer new attachments for a selected text-only model", () => {
    show({ models, model: "nvidia/nemotron-3-ultra-550b-a55b:free" });
    expect(screen.getByRole("button", { name: "Add to prompt" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Add to prompt" }));
    // The closed menu stays mounted, and its items are found by role either way.
    expect(screen.getByRole("button", { name: "Add to prompt" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "Upload media" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Repositories" })).toBeEnabled();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.getByRole("button", { name: "Add to prompt" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    type("Build a text-only page");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("keeps a prepared reference when switching to a text-only model and refuses to send it", async () => {
    const onSubmit = vi.fn();
    const view = show({ onSubmit, models, model: "openai/gpt-5.6-luna" });
    fireEvent.change(screen.getByLabelText("Attach images or videos"), {
      target: { files: [new File(["small"], "reference.png", { type: "image/png" })] },
    });
    await screen.findByRole("button", { name: "Remove reference.png" });
    type("Use my layout");
    view.rerender(
      <ChatInput
        running={false}
        error={undefined}
        onCancel={() => {}}
        onSubmit={onSubmit}
        models={models}
        model="nvidia/nemotron-3-ultra-550b-a55b:free"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/model.*(image|reference)/i);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove reference.png" })).toBeEnabled();
    expect(browser.revokeObjectURL).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove reference.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalledWith("Use my layout");
  });
});

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

  it("can change model while the composer has a long message", () => {
    const { rerender } = show({ models, model: "openai/gpt-oss-20b:free" });
    type("Build a complete to-do application with saved tasks and a polished mobile layout.");

    expect(() =>
      rerender(
        <ChatInput
          running={false}
          error={undefined}
          onSubmit={() => {}}
          onCancel={() => {}}
          models={models}
          model="anthropic/claude-opus-5"
        />,
      ),
    ).not.toThrow();
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

it("allows a queued prompt during compaction while preserving the Stop control", () => {
  const onSubmit = vi.fn();
  show({ running: true, queueing: true, onSubmit });
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "Continue with the filter" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
  expect(onSubmit).toHaveBeenCalledWith("Continue with the filter");
  expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
});

it("restores an owner-bound workspace draft after navigating away", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const draftIdentity = { ownerId: crypto.randomUUID(), projectId: crypto.randomUUID() };
  const props = { draftIdentity, model: "openai/gpt-5.6-luna" };
  const view = show(props);
  await waitFor(() => expect(box()).toBeEnabled());
  type("Keep this follow-up");
  view.unmount();
  show(props);
  await waitFor(() => expect(box()).toHaveValue("Keep this follow-up"));
  vi.unstubAllGlobals();
});

it("flushes the latest workspace draft before a document link and retains it on save failure", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const draftIdentity = { ownerId: crypto.randomUUID(), projectId: crypto.randomUUID() };
  const draft: ComposerDraft = {
    id: draftIdentity.projectId,
    ownerId: draftIdentity.ownerId,
    operationId: draftIdentity.projectId,
    text: "Workspace draft",
    model: "openai/gpt-5.6-luna",
    source: null,
    attachments: [
      {
        kind: "image",
        name: "header.jpg",
        frames: [{ data: "aGVsbG8=", mediaType: "image/jpeg", timestamp: 0 }],
      },
    ],
    expiresAt: Date.now() + 10000,
  };
  await new ComposerDraftStore().save(draft);
  const view = render(
    <>
      <ChatInput
        draftIdentity={draftIdentity}
        model={draft.model}
        running={false}
        error={undefined}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
      <a href="/dashboard">Dashboard</a>
    </>,
  );
  await waitFor(() => expect(box()).toHaveValue(draft.text));
  const save = vi
    .spyOn(ComposerDraftStore.prototype, "save")
    .mockRejectedValue(new Error("Storage full"));
  try {
    type("Last workspace edit");
    expect(fireEvent.click(screen.getByRole("link", { name: "Dashboard" }))).toBe(false);
    await screen.findByText(/Could not save this draft/);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Last workspace edit",
        model: draft.model,
        attachments: draft.attachments,
      }),
    );
    expect(box()).toHaveValue("Last workspace edit");
    view.unmount();
  } finally {
    save.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("never holds a link for a save when the workspace box is empty", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const draftIdentity = { ownerId: crypto.randomUUID(), projectId: crypto.randomUUID() };
  const view = render(
    <>
      <ChatInput
        draftIdentity={draftIdentity}
        running={false}
        error={undefined}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
      <a href="/dashboard">Dashboard</a>
    </>,
  );
  await waitFor(() => expect(box()).toBeEnabled());
  const save = vi
    .spyOn(ComposerDraftStore.prototype, "save")
    .mockReturnValue(new Promise<void>(() => {}));
  try {
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ text: "" })));
    save.mockClear();
    expect(fireEvent.click(screen.getByRole("link", { name: "Dashboard" }))).toBe(true);
    expect(save).not.toHaveBeenCalled();
    view.unmount();
  } finally {
    save.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("writes the emptied box before a link once the message it held was saved and sent", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const draftIdentity = { ownerId: crypto.randomUUID(), projectId: crypto.randomUUID() };
  const onSubmit = vi.fn();
  const view = render(
    <>
      <ChatInput
        draftIdentity={draftIdentity}
        running={false}
        error={undefined}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
      <a href="/dashboard">Dashboard</a>
    </>,
  );
  await waitFor(() => expect(box()).toBeEnabled());
  type("Already sent");
  await waitFor(async () =>
    expect(
      (await new ComposerDraftStore().load(draftIdentity.ownerId, draftIdentity.projectId))?.text,
    ).toBe("Already sent"),
  );
  const save = vi
    .spyOn(ComposerDraftStore.prototype, "save")
    .mockReturnValue(new Promise<void>(() => {}));
  try {
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalledWith("Already sent");
    expect(fireEvent.click(screen.getByRole("link", { name: "Dashboard" }))).toBe(false);
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ text: "", attachments: [] })),
    );
    view.unmount();
  } finally {
    save.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("writes the emptied box before a link when the restored draft was cleared", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const draftIdentity = { ownerId: crypto.randomUUID(), projectId: crypto.randomUUID() };
  await new ComposerDraftStore().save({
    id: draftIdentity.projectId,
    ownerId: draftIdentity.ownerId,
    operationId: draftIdentity.projectId,
    text: "Discard me",
    source: null,
    attachments: [],
    expiresAt: Date.now() + 10000,
  });
  const view = render(
    <>
      <ChatInput
        draftIdentity={draftIdentity}
        running={false}
        error={undefined}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
      <a href="/dashboard">Dashboard</a>
    </>,
  );
  await waitFor(() => expect(box()).toHaveValue("Discard me"));
  const save = vi
    .spyOn(ComposerDraftStore.prototype, "save")
    .mockReturnValue(new Promise<void>(() => {}));
  try {
    type("");
    expect(fireEvent.click(screen.getByRole("link", { name: "Dashboard" }))).toBe(false);
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ text: "" })));
    view.unmount();
  } finally {
    save.mockRestore();
    vi.unstubAllGlobals();
  }
});

it.each(["clear", "send", "failed blank", "failed nonblank"])(
  "waits for a committed nonblank save and the blank flush before leaving after %s",
  async (action) => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const draftIdentity = { ownerId: crypto.randomUUID(), projectId: crypto.randomUUID() };
    const store = new ComposerDraftStore();
    const navigate = vi.fn(() => view.unmount());
    const useNavigation = draftNavigation.useDraftNavigation;
    const navigation = vi
      .spyOn(draftNavigation, "useDraftNavigation")
      .mockImplementation((save, onError) => useNavigation(save, onError, navigate));
    const view = render(
      <>
        <ChatInput
          draftIdentity={draftIdentity}
          running={false}
          error={undefined}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />
        <a href="/settings/connections">Connections</a>
      </>,
    );
    let finishNonblank = () => {};
    let finishBlank = () => {};
    const nonblankCompletion = new Promise<void>((resolve) => {
      finishNonblank = resolve;
    });
    const blankCompletion = new Promise<void>((resolve) => {
      finishBlank = resolve;
    });
    const blankStarted = vi.fn();
    let rejectBlank = action === "failed blank";
    await waitFor(async () =>
      expect(await store.load(draftIdentity.ownerId, draftIdentity.projectId)).toMatchObject({
        text: "",
      }),
    );
    const realSave = ComposerDraftStore.prototype.save;
    const save = vi.spyOn(ComposerDraftStore.prototype, "save").mockImplementation(async function (
      this: ComposerDraftStore,
      value,
    ) {
      if (value.text) {
        await realSave.call(this, value);
        await nonblankCompletion;
        if (action === "failed nonblank") throw new Error("Completion failed");
      } else {
        blankStarted();
        await blankCompletion;
        if (rejectBlank) {
          rejectBlank = false;
          throw new Error("Storage full");
        }
        await realSave.call(this, value);
      }
    });
    try {
      type("Durable before completion");
      await waitFor(async () =>
        expect((await store.load(draftIdentity.ownerId, draftIdentity.projectId))?.text).toBe(
          "Durable before completion",
        ),
      );
      if (action === "send") fireEvent.click(screen.getByRole("button", { name: "Send" }));
      else type("");
      expect(fireEvent.click(screen.getByRole("link", { name: "Connections" }))).toBe(false);
      expect(blankStarted).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      finishNonblank();
      await waitFor(() => expect(blankStarted).toHaveBeenCalled());
      expect(navigate).not.toHaveBeenCalled();
      expect((await store.load(draftIdentity.ownerId, draftIdentity.projectId))?.text).toBe(
        "Durable before completion",
      );
      finishBlank();
      if (action === "failed blank") {
        await screen.findByText(/Could not save this draft/);
        expect(navigate).not.toHaveBeenCalled();
        expect(fireEvent.click(screen.getByRole("link", { name: "Connections" }))).toBe(false);
      }
      await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
      expect(await store.load(draftIdentity.ownerId, draftIdentity.projectId)).toMatchObject({
        text: "",
        attachments: [],
      });
    } finally {
      finishNonblank();
      finishBlank();
      view.unmount();
      save.mockRestore();
      navigation.mockRestore();
      vi.unstubAllGlobals();
    }
  },
);

it("keeps a queued nonblank write unsafe when an older blank finishes", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const draftIdentity = { ownerId: crypto.randomUUID(), projectId: crypto.randomUUID() };
  const store = new ComposerDraftStore();
  const useNavigation = draftNavigation.useDraftNavigation;
  const navigate = vi.fn(() => view.unmount());
  const navigation = vi
    .spyOn(draftNavigation, "useDraftNavigation")
    .mockImplementation((save, onError) => useNavigation(save, onError, navigate));
  let finishOldBlank = () => {};
  let finishNonblank = () => {};
  const oldBlank = new Promise<void>((resolve) => {
    finishOldBlank = resolve;
  });
  const nonblank = new Promise<void>((resolve) => {
    finishNonblank = resolve;
  });
  const realSave = ComposerDraftStore.prototype.save;
  const nonblankStarted = vi.fn();
  let firstBlank = true;
  const save = vi.spyOn(ComposerDraftStore.prototype, "save").mockImplementation(async function (
    this: ComposerDraftStore,
    value,
  ) {
    if (!value.text && firstBlank) {
      firstBlank = false;
      await realSave.call(this, value);
      await oldBlank;
    } else {
      if (value.text) {
        nonblankStarted();
        await nonblank;
      }
      await realSave.call(this, value);
    }
  });
  const view = render(
    <>
      <ChatInput
        draftIdentity={draftIdentity}
        running={false}
        error={undefined}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
      <a href="/settings/connections">Connections</a>
    </>,
  );
  try {
    await waitFor(async () =>
      expect(await store.load(draftIdentity.ownerId, draftIdentity.projectId)).toMatchObject({
        text: "",
      }),
    );
    type("Queued behind blank");
    // Let the autosave debounce enqueue the text while the older blank is still held.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    finishOldBlank();
    await waitFor(() => expect(nonblankStarted).toHaveBeenCalledOnce());
    type("");
    expect(fireEvent.click(screen.getByRole("link", { name: "Connections" }))).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(save.mock.calls.filter(([value]) => !value.text)).toHaveLength(1);
    finishNonblank();
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(await store.load(draftIdentity.ownerId, draftIdentity.projectId)).toMatchObject({
      text: "",
    });
  } finally {
    finishOldBlank();
    finishNonblank();
    view.unmount();
    save.mockRestore();
    navigation.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("never holds a link to write one project's text while the next project's draft loads", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const ownerId = crypto.randomUUID();
  const first = { ownerId, projectId: crypto.randomUUID() };
  const second = { ownerId, projectId: crypto.randomUUID() };
  const link = <a href="/dashboard">Dashboard</a>;
  const props = { running: false, error: undefined, onSubmit: vi.fn(), onCancel: vi.fn() };
  const view = render(
    <>
      <ChatInput draftIdentity={first} {...props} />
      {link}
    </>,
  );
  await waitFor(() => expect(box()).toBeEnabled());
  type("Only for the first project");
  const load = vi
    .spyOn(ComposerDraftStore.prototype, "load")
    .mockReturnValue(new Promise<null>(() => {}));
  const save = vi.spyOn(ComposerDraftStore.prototype, "save");
  try {
    view.rerender(
      <>
        <ChatInput draftIdentity={second} {...props} />
        {link}
      </>,
    );
    expect(load).toHaveBeenCalledWith(ownerId, second.projectId);
    expect(fireEvent.click(screen.getByRole("link", { name: "Dashboard" }))).toBe(true);
    expect(save).not.toHaveBeenCalled();
    view.unmount();
  } finally {
    load.mockRestore();
    save.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("keeps a previous project's late nonblank completion out of the current blank state", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const first = { ownerId: crypto.randomUUID(), projectId: crypto.randomUUID() };
  const second = { ownerId: first.ownerId, projectId: crypto.randomUUID() };
  const store = new ComposerDraftStore();
  await store.save({
    id: second.projectId,
    ownerId: second.ownerId,
    operationId: second.projectId,
    text: "",
    source: null,
    attachments: [],
    expiresAt: Date.now() + 10000,
  });
  let complete = () => {};
  const completion = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const finished = vi.fn();
  const realSave = ComposerDraftStore.prototype.save;
  const save = vi.spyOn(ComposerDraftStore.prototype, "save").mockImplementation(async function (
    this: ComposerDraftStore,
    value,
  ) {
    await realSave.call(this, value);
    if (value.id === first.projectId && value.text) {
      await completion;
      finished();
    }
  });
  const composer = (draftIdentity: typeof first) => (
    <>
      <ChatInput
        draftIdentity={draftIdentity}
        running={false}
        error={undefined}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
      <a href="/settings/connections">Connections</a>
    </>
  );
  const view = render(composer(first));
  try {
    await waitFor(() => expect(box()).toBeEnabled());
    type("Previous project");
    await waitFor(async () =>
      expect((await store.load(first.ownerId, first.projectId))?.text).toBe("Previous project"),
    );
    view.rerender(composer(second));
    await waitFor(() => expect(box()).toHaveValue(""));
    complete();
    await waitFor(() => expect(finished).toHaveBeenCalled());
    save.mockClear();
    expect(fireEvent.click(screen.getByRole("link", { name: "Connections" }))).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect((await store.load(second.ownerId, second.projectId))?.text).toBe("");
  } finally {
    complete();
    view.unmount();
    save.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("resumes workspace draft persistence when its authenticated owner returns after clearing", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const draftIdentity = { ownerId: crypto.randomUUID(), projectId: crypto.randomUUID() };
  const store = new ComposerDraftStore();
  await store.clearOwner(draftIdentity.ownerId);
  const view = show({ draftIdentity });
  try {
    await waitFor(() => expect(box()).toBeEnabled());
    type("Follow-up after signing in again");
    // A read must not be what resumes the writer under test.
    await waitFor(() =>
      expect(
        localStorage.getItem(`nap.draft.${draftIdentity.ownerId}.${draftIdentity.projectId}`),
      ).toBe("1"),
    );
    expect(await store.load(draftIdentity.ownerId, draftIdentity.projectId)).toMatchObject({
      text: "Follow-up after signing in again",
    });
  } finally {
    view.unmount();
    vi.unstubAllGlobals();
  }
});
