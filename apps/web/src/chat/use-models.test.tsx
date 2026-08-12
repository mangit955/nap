import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useModels } from "./use-models.ts";

/**
 * A `.test.tsx` even with no JSX in it: `renderHook` needs a DOM, and a `.test.ts` here would
 * be collected by the Node `unit` project and fail on a missing `document`.
 *
 * **Every "it stays empty" case has to settle first.** `models` begins undefined, so
 * `waitFor(() => expect(models).toBeUndefined())` passes on its first tick, before the fetch
 * has even resolved — which makes it pass against a hook that trusts any body it is handed.
 * Both mutations proved exactly that before `settle` existed.
 */

const LIST = {
  models: [
    { id: "openai/gpt-5.6-luna", label: "Gpt 5 6 Luna", free: false },
    { id: "anthropic/claude-opus-5", label: "Claude Opus 5", free: false },
    { id: "openai/gpt-oss-20b:free", label: "Gpt Oss 20b", free: true },
  ],
  fallback: "openai/gpt-5.6-luna",
};

const answering =
  (body: unknown, status = 200) =>
  async (): Promise<Response> =>
    new Response(JSON.stringify(body), { status });

/** Lets the fetch, the json parse and the state update all happen before anything is asserted. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useModels", () => {
  it("hands back the deployment's list", async () => {
    const { result } = renderHook(() => useModels({ fetchJson: answering(LIST) }));

    await waitFor(() => expect(result.current.models).toEqual(LIST));
  });

  it("stays empty when the request fails, so the picker simply does not appear", async () => {
    // Turns run on the server's default without it. Surfacing this would tell somebody their
    // app is broken because an optional convenience did not load.
    const { result } = renderHook(() =>
      useModels({
        fetchJson: async () => {
          throw new Error("offline");
        },
      }),
    );

    await settle();
    expect(result.current.models).toBeUndefined();
  });

  it("refuses a non-2xx even when its body would have parsed", async () => {
    // The status is the only thing that decides this one. An error body that happens to be
    // shaped like a list — a cached response, a proxy replaying an old one — would otherwise
    // populate the picker from a failed request.
    const { result } = renderHook(() => useModels({ fetchJson: answering(LIST, 503) }));

    await settle();
    expect(result.current.models).toBeUndefined();
  });

  it("refuses a body of the wrong shape rather than trusting it", async () => {
    // An unvalidated body puts an undefined id on a turn, which the route then refuses for
    // naming a model that is not a string — a failure reported two layers from its cause.
    const { result } = renderHook(() =>
      useModels({ fetchJson: answering({ models: [{ id: 7, label: "seven" }], fallback: "x" }) }),
    );

    await settle();
    expect(result.current.models).toBeUndefined();
  });

  it("refuses a body that is well-formed but empty", async () => {
    // An empty list would hide the picker, which looks identical to the endpoint being down —
    // and the schema says a deployment always has at least one model.
    const { result } = renderHook(() =>
      useModels({ fetchJson: answering({ models: [], fallback: "x" }) }),
    );

    await settle();
    expect(result.current.models).toBeUndefined();
  });
});
