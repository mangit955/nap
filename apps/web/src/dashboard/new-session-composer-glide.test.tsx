import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { claimGlide, forgetSendGlide } from "../workspace/send-glide.ts";
import { forgetWorkspaceEntry } from "../workspace/workspace-entry.ts";
import { NewSessionComposer } from "./new-session-composer.tsx";

/**
 * The dashboard's half of the glide into the workspace: where its composer was when the start
 * entered the workspace. The workspace's half is `workspace/send-glide.test.tsx`.
 */

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => "/dashboard",
}));
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  push.mockClear();
  forgetWorkspaceEntry();
  forgetSendGlide();
  vi.restoreAllMocks();
});

async function composerWith(fetchJson: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("indexedDB", new IDBFactory());
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
  return box;
}

it("measures its composer for the glide as it enters the workspace, and not before", async () => {
  const box = await composerWith(() => new Promise<Response>(() => {}));
  const composer = screen.getByRole("group", { name: "New session composer" });
  composer.getBoundingClientRect = () =>
    DOMRect.fromRect({ x: 380, y: 384, width: 736, height: 146 });
  // Writing measures nothing: only entering the workspace does.
  fireEvent.change(box, { target: { value: "Build a calendar" } });
  expect(claimGlide(performance.now())).toBeUndefined();

  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/p/new"));
  expect(claimGlide(performance.now())?.from).toEqual({
    left: 380,
    top: 384,
    right: 1116,
    bottom: 530,
  });
});

it("forgets the glide of a start the server refused", async () => {
  const box = await composerWith(async () =>
    Response.json({ error: "Rate limit" }, { status: 429 }),
  );
  fireEvent.change(box, { target: { value: "Build a calendar" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  // Refused before any workspace drew: a project opened next must not glide in from here.
  expect(await screen.findByText("Rate limit")).toBeInTheDocument();
  expect(push).toHaveBeenCalledWith("/p/new");
  expect(claimGlide(performance.now())).toBeUndefined();
});
