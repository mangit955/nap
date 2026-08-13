import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FetchJson } from "../files/use-project-files.ts";
import { useApiKey } from "./use-api-key.ts";

/**
 * A `.test.tsx` even with no JSX in it: `renderHook` needs a DOM, and a `.test.ts` here would be
 * collected by the Node `unit` project and fail on a missing `document`.
 *
 * The state starts `undefined` and that is load-bearing — it is not the same as "no key", and
 * the welcome step reads the difference. So every "it stays undefined" case has to settle first,
 * or it passes on the first tick against a hook that never asked anything.
 */

const CONFIGURED = { configured: true, platform: "openrouter", hint: "sk-or-…4f2a" };

/** Typed as the hook's own `fetchJson`, so `mock.calls` carries the init argument. */
const answering =
  (body: unknown, status = 200): FetchJson =>
  async (): Promise<Response> =>
    new Response(JSON.stringify(body), { status });

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("reading what is saved", () => {
  it("reports a key that is there", async () => {
    const { result } = renderHook(() => useApiKey({ fetchJson: answering(CONFIGURED) }));

    await waitFor(() =>
      expect(result.current.state).toEqual({
        configured: true,
        platform: "openrouter",
        hint: "sk-or-…4f2a",
      }),
    );
    expect(result.current.loaded).toBe(true);
  });

  it("has not finished asking on the first tick", () => {
    // The state `loaded` exists to describe. A caller drawing a spinner needs a value that is
    // false *before* the answer, or the spinner never appears and the flash it replaces is back.
    const { result } = renderHook(() => useApiKey({ fetchJson: answering(CONFIGURED) }));

    expect(result.current.loaded).toBe(false);
  });

  it("reports no key when there is none", async () => {
    const { result } = renderHook(() => useApiKey({ fetchJson: answering({ configured: false }) }));

    await waitFor(() => expect(result.current.state).toEqual({ configured: false }));
    expect(result.current.loaded).toBe(true);
  });

  it("has finished asking even when the answer was a refusal", async () => {
    const { result } = renderHook(() => useApiKey({ fetchJson: answering({ error: "no" }, 500) }));

    await settle();
    expect(result.current.state).toBeUndefined();
    expect(result.current.loaded).toBe(true);
  });

  it("stays undecided when the server cannot be reached", async () => {
    // Not "no key". Guessing that would flash the paste form at somebody who has one saved,
    // and on the welcome step it would show a page they should have been sent straight past.
    const { result } = renderHook(() =>
      useApiKey({
        fetchJson: async () => {
          throw new Error("offline");
        },
      }),
    );

    await settle();
    expect(result.current.state).toBeUndefined();
    // Undecided, but no longer *asking* — the distinction the welcome step needs to draw a form
    // rather than a spinner that would never stop while the API is down.
    expect(result.current.loaded).toBe(true);
  });

  it("stays undecided when the body is the wrong shape", async () => {
    const { result } = renderHook(() => useApiKey({ fetchJson: answering({ nonsense: true }) }));

    await settle();
    expect(result.current.state).toBeUndefined();
    expect(result.current.loaded).toBe(true);
  });
});

describe("saving", () => {
  it("PUTs the key and takes the answer as the new state", async () => {
    const fetchJson = vi.fn(answering(CONFIGURED));
    const { result } = renderHook(() => useApiKey({ fetchJson }));
    await settle();

    await act(async () => {
      await result.current.save("sk-or-v1-0123456789abcdef0123");
    });

    expect(fetchJson.mock.calls[1]?.[1]).toMatchObject({ method: "PUT" });
    expect(result.current.state).toMatchObject({ configured: true });
  });

  it("keeps the server's own sentence when a key is refused", async () => {
    // It is the only thing that can say *why*. Replacing it with "that did not work" throws
    // away the difference between a typo and a revoked key.
    const { result } = renderHook(() =>
      useApiKey({ fetchJson: answering({ error: "That key was refused." }, 400) }),
    );
    await settle();

    await act(async () => {
      expect(await result.current.save("sk-or-bad")).toBe(false);
    });

    expect(result.current.error).toBe("That key was refused.");
  });

  it("stops being busy even when the request throws", async () => {
    // Without the `finally` this is the sign-in page's worst bug again: the button sits on
    // "Checking…" for as long as the page stays open and nothing says why.
    const { result } = renderHook(() =>
      useApiKey({
        fetchJson: async () => {
          throw new Error("offline");
        },
      }),
    );

    await act(async () => {
      await result.current.save("sk-or-v1-0123456789abcdef0123");
    });

    expect(result.current.busy).toBe(false);
    expect(result.current.error).toContain("couldn't reach the server");
  });
});

describe("removing", () => {
  it("DELETEs and comes back to the free tier", async () => {
    const fetchJson = vi.fn(answering({ configured: false }));
    const { result } = renderHook(() => useApiKey({ fetchJson }));
    await settle();

    await act(async () => {
      await result.current.remove();
    });

    expect(fetchJson.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
    expect(result.current.state).toEqual({ configured: false });
  });
});
