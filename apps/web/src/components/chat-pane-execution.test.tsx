import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { jobView } from "../chat/job-summary.ts";
import type { SessionLog } from "../hooks/use-session-log.ts";
import { LiveChatPane } from "./chat-pane.tsx";

const sessionId = "00000000-0000-4000-8000-000000000010";
const log: SessionLog = {
  events: [],
  status: "open",
  lastSeq: 0,
  replayed: true,
  preview: { status: "idle" },
  changed: new Set(),
  jobs: jobView([]),
};
const modelList = (paidAvailable: boolean) => ({
  models: [
    { id: "openai/gpt-5.6-luna", label: "Luna", free: true, available: true },
    { id: "anthropic/claude-opus-5", label: "Opus", free: false, available: paidAvailable },
  ],
  key: { configured: false },
  fallback: "openai/gpt-5.6-luna",
});

it("UI-002 lets a locked API model open the key form even with unavailable provider metadata", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  render(
    <LiveChatPane
      sessionId={sessionId}
      log={log}
      fetchJson={async (url) => {
        if (url.endsWith("/models")) return Response.json(modelList(false));
        if (url.endsWith("/execution")) return Response.json({ selection: null });
        if (url.endsWith("/providers/targets"))
          return Response.json({
            accounts: [
              {
                account: {
                  id: "00000000-0000-4000-8000-000000000011",
                  driver: "codex",
                  label: null,
                  enabled: true,
                  auth: { status: "unauthenticated", email: null, plan: null },
                  createdAt: "2026-10-24T00:00:00.000Z",
                },
                models: [],
                availability: "unavailable",
              },
            ],
          });
        return Response.json({ present: false });
      }}
    />,
  );
  const picker = await screen.findByRole("combobox", { name: "Account and model" });
  await waitFor(() => expect(picker).toBeEnabled());
  const keyAction = screen.queryByRole("button", { name: /add.*key/i });
  if (keyAction) fireEvent.click(keyAction);
  else {
    const paid = screen.getByRole("option", { name: /Opus.*needs your key/i });
    fireEvent.change(picker, { target: { value: paid.getAttribute("value") } });
  }
  expect(screen.getByRole("dialog", { name: "Your API key" })).toBeInTheDocument();
});

it("UI-005 prevents another model intent while its earlier preference write is unresolved", async () => {
  let release = (_response: Response) => {};
  let intent: unknown;
  render(
    <LiveChatPane
      sessionId={sessionId}
      log={log}
      fetchJson={async (url, init) => {
        if (url.endsWith("/models")) return Response.json(modelList(true));
        if (url.endsWith("/execution")) {
          if (init?.method === "PATCH") {
            intent = JSON.parse(String(init.body));
            return new Promise<Response>((resolve) => {
              release = resolve;
            });
          }
          return Response.json({ selection: null });
        }
        if (url.endsWith("/providers/targets")) return Response.json({ accounts: [] });
        return Response.json({ present: false });
      }}
    />,
  );
  await waitFor(() =>
    expect(screen.queryByRole("status", { name: "Execution selection" })).not.toBeInTheDocument(),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("button", { name: /Opus/ }));
  try {
    expect(screen.getByRole("status", { name: "Execution selection" })).toHaveTextContent(
      "Saving account selection",
    );
    expect(screen.getByRole("button", { name: "Model" })).toBeDisabled();
  } finally {
    release(Response.json({ selection: intent }));
  }
});

it("keeps API selection available after a failed save so an explicit choice can recover", async () => {
  let patches = 0;
  render(
    <LiveChatPane
      sessionId={sessionId}
      log={log}
      fetchJson={async (url, init) => {
        if (url.endsWith("/models")) return Response.json(modelList(true));
        if (url.endsWith("/providers/targets")) return Response.json({ accounts: [] });
        if (url.endsWith("/execution")) {
          if (init?.method === "PATCH") {
            patches++;
            return patches === 1
              ? new Response(null, { status: 503 })
              : Response.json({ selection: JSON.parse(String(init.body)) });
          }
          return Response.json({ selection: null });
        }
        return Response.json({ present: false });
      }}
    />,
  );
  const picker = await screen.findByRole("button", { name: "Model" });
  await waitFor(() => expect(picker).toBeEnabled());
  fireEvent.click(picker);
  fireEvent.click(screen.getByRole("button", { name: /Opus/ }));
  await waitFor(() =>
    expect(screen.getByRole("status", { name: "Execution selection" })).toHaveTextContent(
      "Could not confirm this session's account selection",
    ),
  );
  expect(picker).toBeEnabled();
  fireEvent.click(picker);
  fireEvent.click(screen.getByRole("button", { name: /Opus/ }));
  await waitFor(() => expect(patches).toBe(2));
  await waitFor(() =>
    expect(screen.queryByRole("status", { name: "Execution selection" })).not.toBeInTheDocument(),
  );
});
