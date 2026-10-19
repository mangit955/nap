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

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stashFirstPrompt } from "../chat/first-prompt.ts";
import { jobView } from "../chat/job-summary.ts";
import type { SessionLog } from "../hooks/use-session-log.ts";
import { ev, PROJECT_ID, SESSION_ID } from "../testing/events.ts";
import { mediaBrowser } from "../testing/media-browser.ts";
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
    ev("turn.started", { source: "user" }, 2),
    ev("turn.failed", { reason: "sandbox_unavailable", message: "no capacity" }, 3),
  ];

  return {
    events,
    status: "open",
    lastSeq: 3,
    replayed: true,
    preview: { status: "idle" },
    changed: new Set(),
    jobs: jobView(events),
  };
}

beforeEach(() => {
  turns = [];
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("LiveChatPane", () => {
  it("restores reference bytes after a refused POST and sends the same reference again", async () => {
    const browser = mediaBrowser();
    const posted: unknown[] = [];
    const postMedia = async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/turns")) return fetchJson(url, init);
      posted.push(JSON.parse(String(init?.body)));
      return posted.length === 1
        ? Response.json({ error: "try again" }, { status: 503 })
        : Response.json({ turnId: "8c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f" }, { status: 202 });
    };
    const empty = { ...failedTurn(), events: [], lastSeq: 0, jobs: jobView([]) };
    const view = render(<LiveChatPane sessionId={SESSION_ID} log={empty} fetchJson={postMedia} />);
    try {
      await screen.findByRole("button", { name: "Model" });
      fireEvent.change(screen.getByLabelText("Attach images or videos"), {
        target: { files: [new File(["small"], "reference.png", { type: "image/png" })] },
      });
      await screen.findByRole("button", { name: "Remove reference.png" });
      fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
        target: { value: "Use my layout" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await screen.findByRole("alert");
      await waitFor(() => {
        expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Use my layout");
        expect(screen.getByRole("button", { name: "Remove reference.png" })).toBeInTheDocument();
      });
      expect(browser.revokeObjectURL).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(posted).toHaveLength(2));
      expect(posted).toEqual(
        [0, 1].map(() => ({
          message: "Use my layout",
          attachments: [
            {
              kind: "image",
              name: "reference.png",
              frames: [{ mediaType: "image/jpeg", data: "/9j/AAAA", timestamp: 0 }],
            },
          ],
        })),
      );
      expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    } finally {
      view.unmount();
      browser.restore();
    }
  });

  it("retries replayed video references with every frame byte and timestamp intact", async () => {
    const attachments = [
      {
        kind: "video" as const,
        name: "flow.webm",
        duration: 4,
        frames: [
          { mediaType: "image/jpeg" as const, data: "/9j/AAAA", timestamp: 0.2 },
          { mediaType: "image/jpeg" as const, data: "/9j/BBBB", timestamp: 2 },
          { mediaType: "image/jpeg" as const, data: "/9j/CCCC", timestamp: 3.8 },
        ],
      },
    ];
    const events = [
      ev("user.message", { text: "Match this flow", attachments }, 51),
      ev("turn.started", { source: "user" }, 52),
      ev("turn.failed", { reason: "sandbox_unavailable", message: "no capacity" }, 53),
    ];
    const replayed = { ...failedTurn(), events, lastSeq: 53, jobs: jobView(events) };
    const posted: unknown[] = [];
    render(
      <LiveChatPane
        sessionId={SESSION_ID}
        log={replayed}
        fetchJson={async (url, init) => {
          if (url.endsWith("/turns")) posted.push(JSON.parse(String(init?.body)));
          return fetchJson(url, init);
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await act(async () => {});
    expect(posted).toEqual([{ message: "Match this flow", attachments }]);
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  });

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

  it("marks the seam from a cursor this browser wrote on an earlier visit", async () => {
    // The wiring this file exists for, on a second path: the cursor, the fold that turns it into
    // a position, and the marker are each tested on their own, and none of that says the pane
    // subscribes to any of them. Deleting the `seen` line leaves every one of those green.
    window.localStorage.setItem(`nap.seen.${SESSION_ID}`, "2");

    render(<LiveChatPane sessionId={SESSION_ID} log={failedTurn()} fetchJson={fetchJson} />);

    expect(await screen.findByText(/new since you were last here/i)).toBeInTheDocument();
    // And the cursor moves on to what this visit has now displayed, so closing the tab here
    // leaves nothing to come back to.
    await vi.waitFor(() => expect(window.localStorage.getItem(`nap.seen.${SESSION_ID}`)).toBe("3"));
  });

  it("marks nothing on a session this browser has not opened before", async () => {
    render(<LiveChatPane sessionId={SESSION_ID} log={failedTurn()} fetchJson={fetchJson} />);

    expect(await screen.findByText(/build me a todo list/)).toBeInTheDocument();
    expect(screen.queryByText(/new since you were last here/i)).toBeNull();
  });

  it("says what was decided in an absence, and stops saying it when dismissed", async () => {
    // Same wiring gap as the seam above, one layer further on: the rule, the freeze and the card
    // are each tested alone, and none of that says this pane subscribes to any of them. The turn
    // failed below the cursor, which is a conclusion — so there is something to report.
    window.localStorage.setItem(`nap.seen.${SESSION_ID}`, "2");

    render(<LiveChatPane sessionId={SESSION_ID} log={failedTurn()} fetchJson={fetchJson} />);

    const card = await screen.findByRole("region", { name: /while you were away/i });
    expect(card).toHaveTextContent("The workspace couldn't start.");

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(screen.queryByRole("region", { name: /while you were away/i })).toBeNull();
    // And the transcript is left exactly as it was: the card is additive to the seam, not a
    // replacement for it, so dismissing one does not take the other away.
    expect(screen.getByText(/new since you were last here/i)).toBeInTheDocument();
  });

  it("says nothing about an absence in which nothing was decided", async () => {
    // The four-hours-away case, through the real pane: the cursor is already past the failure,
    // so there is a full log to read and nothing at all to be told about it.
    window.localStorage.setItem(`nap.seen.${SESSION_ID}`, "3");

    render(<LiveChatPane sessionId={SESSION_ID} log={failedTurn()} fetchJson={fetchJson} />);

    expect(await screen.findByText(/build me a todo list/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /while you were away/i })).toBeNull();
  });
});
