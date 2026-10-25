import type { ExecutionSelection } from "@nap/shared/execution-target";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { useSessionExecution } from "./use-session-execution.ts";

const selection: ExecutionSelection = {
  kind: "subscription",
  accountId: "d939aa6e-dc6d-4770-aab6-aa5249cb98ee",
  model: "native-model",
};
const options = {
  sessionId: "session-a",
  fetchJson: async (url: string) =>
    Response.json(url.endsWith("/execution") ? { selection } : { accounts: [] }),
};

it("restores an unavailable subscription without replacing it with API billing", async () => {
  const { result } = renderHook(() => useSessionExecution(options));
  expect(result.current.status).toBe("loading");
  await waitFor(() => expect(result.current.status).toBe("ready"));
  expect(result.current.selection).toEqual(selection);
  expect(result.current.blocked).toBe(true);
  expect(result.current.message).toMatch(/selected subscription.*unavailable/i);
});

it("stays blocked without a session and rejects malformed preferences", async () => {
  const { result, rerender } = renderHook(
    ({ sessionId }: { sessionId: string | undefined }) =>
      useSessionExecution({
        sessionId,
        fetchJson: async (url) =>
          Response.json(
            url.endsWith("/execution")
              ? { selection: { ...selection, generation: 8 } }
              : { accounts: [] },
          ),
      }),
    { initialProps: { sessionId: undefined as string | undefined } },
  );
  expect(result.current.blocked).toBe(true);
  rerender({ sessionId: "a" });
  await waitFor(() => expect(result.current.status).toBe("error"));
  expect(result.current.blocked).toBe(true);
});

it("does not send on the previous API choice after a selection write loses its response", async () => {
  const { result } = renderHook(() =>
    useSessionExecution({
      sessionId: "a",
      fetchJson: async (url, init) => {
        if (init?.method === "PATCH") throw new Error("The write may already have committed");
        return Response.json(
          url.endsWith("/execution")
            ? { selection: { kind: "api", model: "api" } }
            : { accounts: [] },
        );
      },
    }),
  );
  await waitFor(() => expect(result.current.blocked).toBe(false));
  await act(async () => {
    expect(await result.current.choose(selection)).toBe(false);
  });
  expect(result.current.blocked).toBe(true);
  expect(result.current.status).toBe("error");
});

it("blocks submission on preference read failure until an explicit selection is confirmed", async () => {
  let body: unknown;
  const { result } = renderHook(() =>
    useSessionExecution({
      sessionId: "a",
      fetchJson: async (url, init) => {
        if (init?.method === "PATCH") {
          body = JSON.parse(String(init.body));
          return Response.json({ selection: body });
        }
        return url.endsWith("/execution")
          ? new Response("offline", { status: 503 })
          : Response.json({ accounts: [] });
      },
    }),
  );
  await waitFor(() => expect(result.current.status).toBe("error"));
  expect(result.current.blocked).toBe(true);
  await act(async () => {
    await result.current.choose({ kind: "api", model: "explicit-api" });
  });
  expect(body).toEqual({ kind: "api", model: "explicit-api" });
  expect(result.current.selection).toEqual(body);
  expect(result.current.blocked).toBe(false);
});

it("accepts the same confirmed account despite JSON property order and fences a late session response", async () => {
  let finish: (response: Response) => void = () => {};
  const { result, rerender } = renderHook(
    ({ sessionId }) =>
      useSessionExecution({
        sessionId,
        fetchJson: async (url, init) => {
          if (init?.method === "PATCH")
            return new Promise<Response>((resolve) => {
              finish = resolve;
            });
          return Response.json(url.endsWith("/execution") ? { selection: null } : { accounts: [] });
        },
      }),
    { initialProps: { sessionId: "a" } },
  );
  await waitFor(() => expect(result.current.status).toBe("ready"));
  let accepted: Promise<boolean>;
  act(() => {
    accepted = result.current.choose(selection);
  });
  await act(async () => {
    finish(
      Response.json({
        selection: { kind: "subscription", model: selection.model, accountId: selection.accountId },
      }),
    );
    expect(await accepted).toBe(true);
  });
  expect(result.current.selection).toEqual(selection);
  act(() => {
    accepted = result.current.choose({ kind: "api" });
  });
  rerender({ sessionId: "b" });
  await waitFor(() => expect(result.current.status).toBe("ready"));
  await act(async () => {
    finish(Response.json({ selection: { kind: "api" } }));
    expect(await accepted).toBe(false);
  });
  expect(result.current.selection).toBeNull();
  expect(result.current.status).toBe("ready");
});
