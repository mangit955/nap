import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { type ComposerDraft, ComposerDraftStore } from "../projects/composer-draft.ts";
import * as draftNavigation from "../projects/use-draft-navigation.ts";
import { NewSessionComposer } from "./new-session-composer.tsx";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  push.mockClear();
  vi.restoreAllMocks();
});

async function seedDraft(source: ComposerDraft["source"] = null) {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const draft: ComposerDraft = {
    id: crypto.randomUUID(),
    ownerId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    text: "Fix the header",
    model: "openai/gpt-5.6-luna",
    source,
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
  sessionStorage.setItem(`nap.composer.${draft.ownerId}`, draft.id);
  return draft;
}

it("keeps the operation identity through a lost response and a refused overlapping retry", async () => {
  const draft = await seedDraft();
  const fetchJson = vi.fn(async (_url: string, _init?: RequestInit) => {
    if (fetchJson.mock.calls.length === 1) throw new Error("Lost response");
    if (fetchJson.mock.calls.length === 2)
      return Response.json({ error: "Rate limit" }, { status: 429 });
    return Response.json({
      projectId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
    });
  });
  const props = {
    ownerId: draft.ownerId,
    models: [],
    modelsLoading: false,
    onAddKey: vi.fn(),
    fetchJson,
  };
  const first = render(<NewSessionComposer {...props} />);
  const box = screen.getByRole("textbox", { name: "Describe the app you want" });
  await waitFor(() => expect(box).toHaveValue(draft.text));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Lost response");
  fireEvent.click(await screen.findByRole("button", { name: "Retry pending start" }));
  await screen.findByText("Rate limit");
  expect(box).toBeEnabled();
  first.unmount();
  render(<NewSessionComposer {...props} />);
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(draft.text));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(push).toHaveBeenCalledOnce());
  expect(fetchJson.mock.calls[2]?.[1]?.body).toBe(fetchJson.mock.calls[0]?.[1]?.body);
});

it("opens GitHub's settings page carrying the draft when there is nothing to pick", async () => {
  const draft = await seedDraft();
  const fetchJson = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ configured: true, installations: [] }),
  );
  render(
    <NewSessionComposer
      ownerId={draft.ownerId}
      models={[]}
      modelsLoading={false}
      onAddKey={vi.fn()}
      fetchJson={fetchJson}
    />,
  );
  const box = screen.getByRole("textbox", { name: "Describe the app you want" });
  await waitFor(() => expect(box).toHaveValue(draft.text));
  fireEvent.click(screen.getByRole("button", { name: "Add to prompt" }));
  // The closed menu stays mounted, and its items answer a click either way.
  expect(screen.getByRole("button", { name: "Add to prompt" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Repositories" }));
  expect(screen.getByRole("button", { name: "Add to prompt" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  fireEvent.click(await screen.findByRole("button", { name: "Settings → Connections" }));
  await waitFor(() =>
    expect(push).toHaveBeenCalledWith(`/settings/connections/github?draft=${draft.id}`),
  );
});

it("retains the operation ID for an edited refused draft, and a new draft gets a new ID", async () => {
  const draft = await seedDraft();
  const fetchJson = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ error: "Operation already committed" }, { status: 409 }),
  );
  const props = {
    ownerId: draft.ownerId,
    models: [],
    modelsLoading: false,
    onAddKey: vi.fn(),
    fetchJson,
  };
  const first = render(<NewSessionComposer {...props} />);
  const box = screen.getByRole("textbox", { name: "Describe the app you want" });
  await waitFor(() => expect(box).toHaveValue(draft.text));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Operation already committed");
  fireEvent.change(box, { target: { value: "Different task" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(2));
  await screen.findByText("Operation already committed");
  expect(JSON.parse(String(fetchJson.mock.calls[1]?.[1]?.body))).toMatchObject({
    operationId: draft.operationId,
    prompt: { message: "Different task" },
  });
  first.unmount();
  sessionStorage.removeItem(`nap.composer.${draft.ownerId}`);
  render(<NewSessionComposer {...props} />);
  const fresh = screen.getByRole("textbox", { name: "Describe the app you want" });
  await waitFor(() => expect(fresh).toBeEnabled());
  fireEvent.change(fresh, { target: { value: "Intentional new session" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(3));
  expect(JSON.parse(String(fetchJson.mock.calls[2]?.[1]?.body)).operationId).not.toBe(
    draft.operationId,
  );
  await screen.findByText("Operation already committed");
});

it("can send a template after editing and removing its repository settings", async () => {
  const draft = await seedDraft({
    installationId: 1,
    repositoryId: 11,
    name: "example/storefront",
    baseBranch: "main",
    environment: { setupCommand: null, devCommand: null, previewPort: null },
    autoPublish: false,
    repository: { id: 11, fullName: "example/storefront", defaultBranch: "main", private: true },
  });
  const fetchJson = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ error: "Reached start" }, { status: 429 }),
  );
  render(
    <NewSessionComposer
      ownerId={draft.ownerId}
      models={[]}
      modelsLoading={false}
      onAddKey={vi.fn()}
      fetchJson={fetchJson}
    />,
  );
  await screen.findByRole("button", { name: "Remove repository" });
  fireEvent.click(screen.getByText("Source settings", { selector: "summary" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Base branch" }), {
    target: { value: "other" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Remove repository" }));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Reached start");
  expect(JSON.parse(String(fetchJson.mock.calls[0]?.[1]?.body))).toMatchObject({
    source: { kind: "template" },
    prompt: { message: draft.text, model: draft.model, attachments: draft.attachments },
  });
});

it("flushes current text, model and media on an anchor click and stops if storage fails", async () => {
  const draft = await seedDraft();
  render(
    <>
      <NewSessionComposer
        ownerId={draft.ownerId}
        models={[]}
        modelsLoading={false}
        onAddKey={vi.fn()}
      />
      <a href="/p/other">Other session</a>
    </>,
  );
  const box = screen.getByRole("textbox", { name: "Describe the app you want" });
  await waitFor(() => expect(box).toHaveValue(draft.text));
  const save = vi
    .spyOn(ComposerDraftStore.prototype, "save")
    .mockRejectedValue(new Error("Storage full"));
  fireEvent.change(box, { target: { value: "Last edit before leaving" } });
  expect(fireEvent.click(screen.getByRole("link", { name: "Other session" }))).toBe(false);
  await screen.findByText(/Could not save your draft/);
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      text: "Last edit before leaving",
      model: draft.model,
      attachments: draft.attachments,
    }),
  );
  expect(box).toHaveValue("Last edit before leaving");
});

it("lets a link go at once from an empty composer, even with storage broken", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  render(
    <>
      <NewSessionComposer
        ownerId="00000000-0000-4000-8000-000000000001"
        models={[]}
        modelsLoading={false}
        onAddKey={vi.fn()}
      />
      <a href="/settings/providers">Providers</a>
    </>,
  );
  const box = await screen.findByRole("textbox", { name: "Describe the app you want" });
  await waitFor(() => expect(box).toBeEnabled());
  const save = vi
    .spyOn(ComposerDraftStore.prototype, "save")
    .mockReturnValue(new Promise<void>(() => {}));
  try {
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ text: "" })));
    save.mockClear();
    expect(fireEvent.click(screen.getByRole("link", { name: "Providers" }))).toBe(true);
    expect(save).not.toHaveBeenCalled();
  } finally {
    save.mockRestore();
  }
});

it("writes the emptied composer before a link once its text had been saved", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const ownerId = "00000000-0000-4000-8000-000000000001";
  render(
    <>
      <NewSessionComposer ownerId={ownerId} models={[]} modelsLoading={false} onAddKey={vi.fn()} />
      <a href="/settings/providers">Providers</a>
    </>,
  );
  const box = await screen.findByRole("textbox", { name: "Describe the app you want" });
  await waitFor(() => expect(box).toBeEnabled());
  fireEvent.change(box, { target: { value: "A todo app" } });
  await waitFor(async () => {
    const id = sessionStorage.getItem(`nap.composer.${ownerId}`);
    expect(id && (await new ComposerDraftStore().load(ownerId, id))?.text).toBe("A todo app");
  });
  const save = vi
    .spyOn(ComposerDraftStore.prototype, "save")
    .mockReturnValue(new Promise<void>(() => {}));
  fireEvent.change(box, { target: { value: "" } });
  expect(fireEvent.click(screen.getByRole("link", { name: "Providers" }))).toBe(false);
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ text: "" })));
});

it.each(["clear", "failed blank", "failed nonblank"])(
  "waits for a committed nonblank save and the blank flush before leaving after %s",
  async (action) => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const ownerId = crypto.randomUUID();
    const store = new ComposerDraftStore();
    const navigate = vi.fn(() => view.unmount());
    const useNavigation = draftNavigation.useDraftNavigation;
    vi.spyOn(draftNavigation, "useDraftNavigation").mockImplementation((save, onError) =>
      useNavigation(save, onError, navigate),
    );
    const view = render(
      <>
        <NewSessionComposer
          ownerId={ownerId}
          models={[]}
          modelsLoading={false}
          onAddKey={vi.fn()}
        />
        <a href="/settings/connections">Connections</a>
      </>,
    );
    const box = screen.getByRole("textbox", { name: "Describe the app you want" });
    await waitFor(() => expect(sessionStorage.getItem(`nap.composer.${ownerId}`)).not.toBeNull());
    const id = sessionStorage.getItem(`nap.composer.${ownerId}`)!;
    expect(await store.load(ownerId, id)).toMatchObject({ text: "" });
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
      fireEvent.change(box, { target: { value: "Durable before completion" } });
      await waitFor(async () =>
        expect((await store.load(ownerId, id))?.text).toBe("Durable before completion"),
      );
      fireEvent.change(box, { target: { value: "" } });
      expect(fireEvent.click(screen.getByRole("link", { name: "Connections" }))).toBe(false);
      expect(blankStarted).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      finishNonblank();
      await waitFor(() => expect(blankStarted).toHaveBeenCalled());
      expect(navigate).not.toHaveBeenCalled();
      expect((await store.load(ownerId, id))?.text).toBe("Durable before completion");
      finishBlank();
      if (action === "failed blank") {
        await screen.findByText(/Could not save your draft/);
        expect(navigate).not.toHaveBeenCalled();
        expect(fireEvent.click(screen.getByRole("link", { name: "Connections" }))).toBe(false);
      }
      await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
      expect(await store.load(ownerId, id)).toMatchObject({ text: "", attachments: [] });
    } finally {
      finishNonblank();
      finishBlank();
      view.unmount();
      save.mockRestore();
    }
  },
);

it("keeps a queued nonblank write unsafe when an older blank finishes", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const ownerId = crypto.randomUUID();
  const store = new ComposerDraftStore();
  const useNavigation = draftNavigation.useDraftNavigation;
  const navigate = vi.fn(() => view.unmount());
  vi.spyOn(draftNavigation, "useDraftNavigation").mockImplementation((save, onError) =>
    useNavigation(save, onError, navigate),
  );
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
  let id = "";
  const save = vi.spyOn(ComposerDraftStore.prototype, "save").mockImplementation(async function (
    this: ComposerDraftStore,
    value,
  ) {
    id = value.id;
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
      <NewSessionComposer ownerId={ownerId} models={[]} modelsLoading={false} onAddKey={vi.fn()} />
      <a href="/settings/connections">Connections</a>
    </>,
  );
  const box = screen.getByRole("textbox", { name: "Describe the app you want" });
  try {
    await waitFor(async () =>
      expect(id && (await store.load(ownerId, id))).toMatchObject({ text: "" }),
    );
    fireEvent.change(box, { target: { value: "Queued behind blank" } });
    // Let the autosave debounce enqueue the text while the older blank is still held.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    finishOldBlank();
    await waitFor(() => expect(nonblankStarted).toHaveBeenCalledOnce());
    fireEvent.change(box, { target: { value: "" } });
    expect(fireEvent.click(screen.getByRole("link", { name: "Connections" }))).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(save.mock.calls.filter(([value]) => !value.text)).toHaveLength(1);
    finishNonblank();
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(await store.load(ownerId, id)).toMatchObject({ text: "" });
  } finally {
    finishOldBlank();
    finishNonblank();
    view.unmount();
    save.mockRestore();
  }
});

it("keeps a previous owner's late nonblank completion out of the current blank state", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const firstOwner = crypto.randomUUID();
  const secondOwner = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  const store = new ComposerDraftStore();
  await store.save({
    id: secondId,
    ownerId: secondOwner,
    operationId: secondId,
    text: "",
    source: null,
    attachments: [],
    expiresAt: Date.now() + 10000,
  });
  sessionStorage.setItem(`nap.composer.${secondOwner}`, secondId);
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
    if (value.ownerId === firstOwner && value.text) {
      await completion;
      finished();
    }
  });
  const composer = (ownerId: string) => (
    <>
      <NewSessionComposer ownerId={ownerId} models={[]} modelsLoading={false} onAddKey={vi.fn()} />
      <a href="/settings/connections">Connections</a>
    </>
  );
  const view = render(composer(firstOwner));
  const box = screen.getByRole("textbox", { name: "Describe the app you want" });
  try {
    await waitFor(() =>
      expect(sessionStorage.getItem(`nap.composer.${firstOwner}`)).not.toBeNull(),
    );
    const firstId = sessionStorage.getItem(`nap.composer.${firstOwner}`)!;
    fireEvent.change(box, { target: { value: "Previous owner" } });
    await waitFor(async () =>
      expect((await store.load(firstOwner, firstId))?.text).toBe("Previous owner"),
    );
    view.rerender(composer(secondOwner));
    await waitFor(() => expect(box).toHaveValue(""));
    complete();
    await waitFor(() => expect(finished).toHaveBeenCalled());
    save.mockClear();
    expect(fireEvent.click(screen.getByRole("link", { name: "Connections" }))).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(`nap.composer.${secondOwner}`)).toBe(secondId);
    expect((await store.load(secondOwner, secondId))?.text).toBe("");
  } finally {
    complete();
    view.unmount();
    save.mockRestore();
  }
});

it("starts a template with its task and model once, without browser first-prompt replay", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const fetchJson = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({
      projectId: "00000000-0000-4000-8000-000000000002",
      sessionId: "00000000-0000-4000-8000-000000000003",
      requestId: "00000000-0000-4000-8000-000000000004",
    }),
  );
  render(
    <NewSessionComposer
      ownerId="00000000-0000-4000-8000-000000000001"
      models={[]}
      modelsLoading={false}
      fallback="free"
      onAddKey={vi.fn()}
      fetchJson={fetchJson}
    />,
  );
  const box = await screen.findByRole("textbox", { name: "Describe the app you want" });
  await waitFor(() => expect(box).toBeEnabled());
  fireEvent.change(box, { target: { value: "Build a calendar" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/p/00000000-0000-4000-8000-000000000002"));
  expect(fetchJson).toHaveBeenCalledOnce();
  expect(JSON.parse(String(fetchJson.mock.calls[0]?.[1]?.body))).toMatchObject({
    source: { kind: "template" },
    prompt: { message: "Build a calendar" },
  });
  expect(sessionStorage.getItem("nap.first-prompt")).toBeNull();
});

it("recovers a lost start response with the identical saved request after remount", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const fetchJson = vi.fn(async (_url: string, _init?: RequestInit) => {
    if (fetchJson.mock.calls.length === 1) throw new Error("Lost response");
    return Response.json({
      projectId: "00000000-0000-4000-8000-000000000002",
      sessionId: "00000000-0000-4000-8000-000000000003",
      requestId: "00000000-0000-4000-8000-000000000004",
    });
  });
  const props = {
    ownerId: "00000000-0000-4000-8000-000000000001",
    models: [],
    modelsLoading: false,
    onAddKey: vi.fn(),
    fetchJson,
  };
  const first = render(<NewSessionComposer {...props} />);
  const box = screen.getByRole("textbox", { name: "Describe the app you want" });
  await waitFor(() => expect(box).toBeEnabled());
  fireEvent.change(box, { target: { value: "Build the calendar" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Lost response");
  first.unmount();
  render(<NewSessionComposer {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry pending start" }));
  await waitFor(() => expect(push).toHaveBeenCalledOnce());
  expect(fetchJson.mock.calls).toHaveLength(2);
  expect(fetchJson.mock.calls[0]?.[1]?.body).toBe(fetchJson.mock.calls[1]?.[1]?.body);
});

it("keeps the pending-start notice out of the composer while the request is in flight", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  let answer: (response: Response) => void = () => {};
  const fetchJson = vi.fn(
    (_url: string, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  );
  render(
    <NewSessionComposer
      ownerId="00000000-0000-4000-8000-000000000001"
      models={[]}
      modelsLoading={false}
      onAddKey={vi.fn()}
      fetchJson={fetchJson}
    />,
  );
  const box = screen.getByRole("textbox", { name: "Describe the app you want" });
  await waitFor(() => expect(box).toBeEnabled());
  fireEvent.change(box, { target: { value: "Build me a cool todo app." } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fetchJson).toHaveBeenCalledOnce());
  expect(box).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Retry pending start" })).toBeNull();
  answer(Response.json({ error: "Upstream unavailable" }, { status: 503 }));
  await screen.findByText("Upstream unavailable");
  expect(await screen.findByRole("button", { name: "Retry pending start" })).toBeEnabled();
});

it("resumes draft persistence for an authenticated owner returning without a draft pointer", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  window.history.replaceState(null, "", "/dashboard");
  const ownerId = crypto.randomUUID();
  const store = new ComposerDraftStore();
  await store.clearOwner(ownerId);
  const view = render(
    <NewSessionComposer
      ownerId={ownerId}
      models={[]}
      modelsLoading={false}
      onAddKey={vi.fn()}
      fetchJson={vi.fn()}
    />,
  );
  try {
    const box = screen.getByRole("textbox", { name: "Describe the app you want" });
    await waitFor(() => expect(box).toBeEnabled());
    fireEvent.change(box, { target: { value: "New work after signing in again" } });
    // Do not poll load here: the old load implementation would itself resume writes and mask the bug.
    await waitFor(() => {
      const id = sessionStorage.getItem(`nap.composer.${ownerId}`);
      expect(id).not.toBeNull();
      expect(localStorage.getItem(`nap.draft.${ownerId}.${id}`)).toBe("1");
    });
    const id = sessionStorage.getItem(`nap.composer.${ownerId}`);
    expect(await store.load(ownerId, id!)).toMatchObject({
      text: "New work after signing in again",
    });
  } finally {
    view.unmount();
  }
});

it("reports the repository to thread details and opens source settings when the card requests it", async () => {
  const draft = await seedDraft({
    installationId: 1,
    repositoryId: 11,
    name: "example/storefront",
    baseBranch: "main",
    environment: { setupCommand: null, devCommand: null, previewPort: null },
    autoPublish: false,
    repository: { id: 11, fullName: "example/storefront", defaultBranch: "main", private: true },
  });
  const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  try {
    const onSourceChange = vi.fn();
    const props = {
      ownerId: draft.ownerId,
      models: [],
      modelsLoading: false,
      onAddKey: vi.fn(),
      onSourceChange,
    };
    const view = render(<NewSessionComposer {...props} settingsRequest={0} />);
    await waitFor(() =>
      expect(onSourceChange).toHaveBeenLastCalledWith({
        fullName: "example/storefront",
        baseBranch: "main",
        devCommand: null,
      }),
    );
    view.rerender(<NewSessionComposer {...props} settingsRequest={1} />);
    const branch = screen.getByRole("textbox", { name: "Base branch" });
    expect(branch).toBeVisible();
    expect(branch).toHaveFocus();
    fireEvent.change(branch, { target: { value: "develop" } });
    fireEvent.submit(screen.getByRole("form", { name: "Source settings" }));
    await waitFor(() =>
      expect(onSourceChange).toHaveBeenLastCalledWith({
        fullName: "example/storefront",
        baseBranch: "develop",
        devCommand: null,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove repository" }));
    await waitFor(() => expect(onSourceChange).toHaveBeenLastCalledWith(null));
  } finally {
    if (previous) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", previous);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});
