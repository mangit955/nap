import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useModels } from "../chat/use-models.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { forgetAccount } from "./account-cache.ts";
import { useApiKey } from "./use-api-key.ts";

/**
 * The account's models and key, read once per tab and shared (`account-cache.ts`).
 *
 * What a cache can get wrong is when it reads again, so that is what these pin: a key saved in one
 * place reaches every other reader and re-reads the models, whose availability follows the key; a
 * failed read is asked again; sign-out empties it; an answer overtaken by a save is dropped.
 * `testing/setup.ts` empties it between tests.
 */

const LOCKED = {
  models: [
    { id: "free/one:free", label: "One", free: true, available: true },
    { id: "anthropic/claude-opus-5", label: "Opus", free: false, available: false },
  ],
  fallback: "free/one:free",
  key: { configured: false },
};
const UNLOCKED = {
  models: [
    { id: "free/one:free", label: "One", free: true, available: true },
    { id: "anthropic/claude-opus-5", label: "Opus", free: false, available: true },
  ],
  fallback: "anthropic/claude-opus-5",
  key: { configured: true, platform: "openrouter", hint: "sk-or-…4f2a" },
};
const SAVED = { configured: true, platform: "openrouter", hint: "sk-or-…4f2a" };

/** An API whose key is whatever was last saved, and whose model list follows it. */
function account() {
  let configured = false;
  const fetchJson = vi.fn<FetchJson>(async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/account/api-key" && init?.method === "PUT") {
      configured = true;
      return Response.json(SAVED);
    }
    if (path === "/account/api-key")
      return Response.json(configured ? SAVED : { configured: false });
    if (path === "/models") return Response.json(configured ? UNLOCKED : LOCKED);
    return Response.json({ error: "not found" }, { status: 404 });
  });
  const reads = (path: string) =>
    fetchJson.mock.calls.filter(([url, init]) => new URL(url).pathname === path && !init?.method)
      .length;
  return { fetchJson, reads };
}

describe("one read for the whole tab", () => {
  it("serves every reader from one read, however many mount", async () => {
    const api = account();
    const first = renderHook(() => ({
      key: useApiKey({ fetchJson: api.fetchJson }),
      models: useModels({ fetchJson: api.fetchJson }),
    }));
    // The sidebar and the composer ask side by side.
    renderHook(() => useApiKey({ fetchJson: api.fetchJson }));
    await waitFor(() => expect(first.result.current.models.models).toEqual(LOCKED));
    first.unmount();

    // A project opened later draws both at once, asking for neither.
    const later = renderHook(() => ({
      key: useApiKey({ fetchJson: api.fetchJson }),
      models: useModels({ fetchJson: api.fetchJson }),
    }));
    expect(later.result.current.key.state).toEqual({ configured: false });
    expect(later.result.current.models).toEqual({ models: LOCKED, loading: false });
    expect(api.reads("/account/api-key")).toBe(1);
    expect(api.reads("/models")).toBe(1);
  });

  it("asks again after a read that failed, rather than keeping the failure", async () => {
    let up = false;
    const fetchJson: FetchJson = async () =>
      up ? Response.json(LOCKED) : Response.json({ error: "down" }, { status: 503 });
    const first = renderHook(() => useModels({ fetchJson }));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.models).toBeUndefined();
    first.unmount();

    up = true;
    const second = renderHook(() => useModels({ fetchJson }));
    // Asking again is not done asking: a caller waiting on it must wait for this answer too.
    expect(second.result.current.loading).toBe(true);
    await waitFor(() => expect(second.result.current.models).toEqual(LOCKED));
  });

  it("starts empty after sign-out, so the next person reads their own", async () => {
    const api = account();
    const first = renderHook(() => useApiKey({ fetchJson: api.fetchJson }));
    await waitFor(() => expect(first.result.current.loaded).toBe(true));
    first.unmount();

    forgetAccount();
    const next = renderHook(() => useApiKey({ fetchJson: api.fetchJson }));
    expect(next.result.current.loaded).toBe(false);
    await waitFor(() => expect(next.result.current.loaded).toBe(true));
    expect(api.reads("/account/api-key")).toBe(2);
  });
  it("reads again when the tab comes back into view, once however many read it", async () => {
    // A key saved on another device, or a deploy that changed the allowlist, while this tab was
    // in the background.
    const api = account();
    renderHook(() => useModels({ fetchJson: api.fetchJson }));
    renderHook(() => useModels({ fetchJson: api.fetchJson }));
    await waitFor(() => expect(api.reads("/models")).toBe(1));

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(api.reads("/models")).toBe(2));
  });
});

describe("a key saved anywhere", () => {
  it("reaches every reader, and the models are read again for it", async () => {
    const api = account();
    // The settings dialog and the composer's picker, mounted side by side.
    const settings = renderHook(() => useApiKey({ fetchJson: api.fetchJson }));
    const composer = renderHook(() => ({
      key: useApiKey({ fetchJson: api.fetchJson }),
      models: useModels({ fetchJson: api.fetchJson }),
    }));
    await waitFor(() => expect(composer.result.current.models.models).toEqual(LOCKED));

    await act(async () => {
      await settings.result.current.save("sk-or-v1-abcdef");
    });

    expect(composer.result.current.key.state).toEqual(SAVED);
    await waitFor(() => expect(composer.result.current.models.models).toEqual(UNLOCKED));
    // The picker kept drawing the old list while the new one was read, rather than vanishing.
    expect(api.reads("/models")).toBe(2);
  });

  it("is not undone by a read that was already on its way", async () => {
    let answer: (response: Response) => void = () => {};
    const fetchJson = vi.fn<FetchJson>(async (url, init) => {
      if (init?.method === "PUT") return Response.json(SAVED);
      if (new URL(url).pathname === "/models") return Response.json(UNLOCKED);
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    });
    const { result } = renderHook(() => useApiKey({ fetchJson }));
    await waitFor(() => expect(fetchJson).toHaveBeenCalledOnce());

    await act(async () => {
      await result.current.save("sk-or-v1-abcdef");
    });
    expect(result.current.state).toEqual(SAVED);

    // The read from before the save answers last, with the state from before the save.
    await act(async () => {
      answer(Response.json({ configured: false }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.state).toEqual(SAVED);
  });

  it("tells the other tabs, which read both again", async () => {
    const api = account();
    const { result } = renderHook(() => ({
      key: useApiKey({ fetchJson: api.fetchJson }),
      models: useModels({ fetchJson: api.fetchJson }),
    }));
    await waitFor(() => expect(result.current.models.models).toEqual(LOCKED));

    // Another tab saved a key: the server now says so, and that tab announces it.
    await api.fetchJson("http://localhost:3001/account/api-key", { method: "PUT" });
    const otherTab = new BroadcastChannel("nap-account");
    otherTab.postMessage("key");
    otherTab.close();

    await waitFor(() => expect(result.current.key.state).toEqual(SAVED));
    await waitFor(() => expect(result.current.models.models).toEqual(UNLOCKED));
  });
});
