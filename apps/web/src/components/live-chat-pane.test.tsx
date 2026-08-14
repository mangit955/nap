/**
 * That the retry button is actually connected to something.
 *
 * Every other test in this folder renders the presentational half with a `vi.fn()`, which proves
 * the button calls its prop and says nothing about whether the live component passes one. That
 * gap is not theoretical: dropping the `onRetry` line from `LiveChatPane` left all 232 web tests
 * green while the button silently stopped existing — the same class of bug as the boot wiring
 * that once shipped a server with its rate limits unwired, and found the same way — by deleting
 * the line to see what failed.
 *
 * Nothing is mocked. The pane takes its log and its `fetchJson` as arguments, so the real
 * submission hook runs against a fake server and the real fold turns the fake server's events
 * into the transcript the button is drawn from.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stashFirstPrompt } from "../chat/first-prompt.ts";
import type { SessionLog } from "../hooks/use-session-log.ts";
import { ev, PROJECT_ID, SESSION_ID } from "../testing/events.ts";
import { LiveChatPane } from "./chat-pane.tsx";

const MODELS = {
  models: [
    { id: "openai/gpt-5.6-luna", label: "Gpt 5 6 Luna", free: false, available: true },
    { id: "anthropic/claude-opus-5", label: "Claude Opus 5", free: false, available: true },
  ],
  key: { configured: false },
  fallback: "openai/gpt-5.6-luna",
};

/** Every turn the pane asked for, so "the retry went through `submit`" is a countable thing. */
let turns: { message: string; model?: string }[] = [];

/** A server that answers the three requests this pane makes on mount, and accepts a turn. */
const fetchJson = async (url: string, init?: RequestInit): Promise<Response> => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  if (url.endsWith("/models")) return json(MODELS);
  if (url.includes("/account/api-key")) return json({ present: false });
  if (url.includes("/turns")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { message: string; model?: string };
    turns.push(body);
    return json({ turnId: "e7a1c2d3-4b5a-4c6d-8e9f-0a1b2c3d4e5f" }, 202);
  }

  return json({ files: [], ready: true });
};

/** A log holding one failed turn — which is what puts a retry button on screen. */
function failedTurn(): SessionLog {
  const events = [
    ev("user.message", { text: "build me a todo list" }, 1),
    ev("turn.started", {}, 2),
    ev("turn.failed", { reason: "sandbox_unavailable", message: "no capacity" }, 3),
  ];

  return {
    events,
    status: "open",
    lastSeq: 3,
    replayed: true,
    preview: { status: "idle" },
    changed: new Set(),
  };
}

beforeEach(() => {
  turns = [];
  window.sessionStorage.clear();
});

describe("LiveChatPane", () => {
  it("sends a failed turn's message again when the retry is pressed", async () => {
    render(<LiveChatPane sessionId={SESSION_ID} log={failedTurn()} fetchJson={fetchJson} />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    // Through the submission hook, not some second path: a retry is an ordinary turn and has to
    // be subject to the same rate limit and the same optimistic message as anything typed into
    // the box. It carries the chosen model too — retrying on a different one silently is the
    // worst version of this control, since the turn that failed and the turn that replaces it
    // would cost different amounts for no stated reason.
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0]?.message).toBe("build me a todo list");
  });

  it("keeps the dashboard model selected after sending its first prompt", async () => {
    stashFirstPrompt(PROJECT_ID, {
      text: "build me a todo list",
      model: "anthropic/claude-opus-5",
    });

    render(
      <LiveChatPane
        projectId={PROJECT_ID}
        sessionId={SESSION_ID}
        log={failedTurn()}
        fetchJson={fetchJson}
      />,
    );

    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0]?.model).toBe("anthropic/claude-opus-5");
    expect(await screen.findByRole("button", { name: "Model" })).toHaveTextContent("Claude Opus 5");
  });
});
