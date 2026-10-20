import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { NewSessionComposer } from "./new-session-composer.tsx";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  push.mockClear();
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
