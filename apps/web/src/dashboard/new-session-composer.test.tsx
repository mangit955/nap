import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { type ComposerDraft, ComposerDraftStore } from "../projects/composer-draft.ts";
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
    expect(fireEvent.click(screen.getByRole("link", { name: "Providers" }))).toBe(true);
    expect(save).not.toHaveBeenCalled();
  } finally {
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
