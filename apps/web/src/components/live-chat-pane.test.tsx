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

import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import type { MediaAttachment } from "@nap/shared/media";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../../api/src/app.ts";
import { createLogger } from "../../../api/src/logger.ts";
import { resolveTurnAccess } from "../../../api/src/turns/model-access.ts";
import { stashFirstPrompt } from "../chat/first-prompt.ts";
import { jobView } from "../chat/job-summary.ts";
import type { SessionLog } from "../hooks/use-session-log.ts";
import { ev, OTHER_SESSION_ID, PROJECT_ID, SESSION_ID } from "../testing/events.ts";
import { JOB_ID, jobLog } from "../testing/job-events.ts";
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

const FIRST_PROMPT = {
  text: "Use the pasted layout and this flow",
  model: "anthropic/claude-opus-5",
  attachments: [
    {
      kind: "image",
      name: "pasted.png",
      frames: [{ mediaType: "image/jpeg", data: "/9j/DDDD", timestamp: 0 }],
    },
    {
      kind: "video",
      name: "flow.webm",
      duration: 4,
      frames: [
        { mediaType: "image/jpeg", data: "/9j/AAAA", timestamp: 0.2 },
        { mediaType: "image/jpeg", data: "/9j/BBBB", timestamp: 2 },
        { mediaType: "image/jpeg", data: "/9j/CCCC", timestamp: 3.8 },
      ],
    },
  ] satisfies MediaAttachment[],
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
    if (init?.method !== "POST") return json({ id: url.split("/").at(-1), state: "queued" });
    const body = JSON.parse(String(init?.body ?? "{}")) as { message: string; model?: string };
    turns.push(body);
    return json({ accepted: true, requestId: "e7a1c2d3-4b5a-4c6d-8e9f-0a1b2c3d4e5f" }, 202);
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
  it("enables the composer and Context after reloading a recovered verification child", async () => {
    const request = "00000000-0000-4000-8000-000000000002";
    const repair = "00000000-0000-4000-8000-000000000003";
    const jobId = "00000000-0000-4000-8000-000000000004";
    const events = [
      ev("user.message", { text: "Build it" }, 1, { turnId: request }),
      ev("agent.message", { text: "Built the dashboard" }, 2, { turnId: request }),
      ev(
        "turn.completed",
        { usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1, commitSha: "abc" },
        3,
        { turnId: request },
      ),
      ev("user.message", { text: "Repair it", repair: { requestId: request, jobId } }, 4, {
        turnId: repair,
      }),
      ev("turn.started", { source: "verification" }, 5, { turnId: repair }),
      ev("turn.failed", { reason: "internal", message: "interrupted" }, 6, { turnId: repair }),
      ev("system.notice", { level: "warning", text: "Reopen the project" }, 7, { turnId: request }),
    ];
    const replayed = { ...failedTurn(), events, lastSeq: 7, jobs: jobView(events) };
    render(<LiveChatPane sessionId={SESSION_ID} log={replayed} fetchJson={fetchJson} />);
    await screen.findByRole("button", { name: "Model" });
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Agent is working" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Context, usage not reported"));
    expect(screen.getByRole("button", { name: "Compact context" })).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Add a footer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0]?.message).toBe("Add a footer");
  });

  it("enables the composer and Context after reloading a late duplicate recovery start", async () => {
    const compact = "00000000-0000-4000-8000-000000000002";
    const marker = ev("compaction.started", { id: compact, trigger: "manual" }, 4, {
      turnId: compact,
    });
    const events = [
      ev("user.message", { text: "old work" }, 1),
      ev("agent.message", { text: "Done" }, 2),
      ev(
        "turn.completed",
        {
          usage: { inputTokens: 1, outputTokens: 1 },
          durationMs: 10,
          commitSha: null,
        },
        3,
      ),
      marker,
      ev(
        "compaction.failed",
        {
          id: compact,
          message: "interrupted",
          cancelled: false,
          usage: null,
        },
        5,
        { turnId: compact },
      ),
      ev("turn.failed", { reason: "internal", message: "interrupted" }, 6, { turnId: compact }),
      { ...marker, seq: 7, createdAt: "2026-08-09T12:00:07.000Z" },
    ];
    const replayed = { ...failedTurn(), events, lastSeq: 7, jobs: jobView(events) };
    render(<LiveChatPane sessionId={SESSION_ID} log={replayed} fetchJson={fetchJson} />);
    await screen.findByRole("button", { name: "Model" });
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Agent is working" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Context, usage not reported"));
    expect(screen.getByRole("button", { name: "Compact context" })).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Add a footer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0]?.message).toBe("Add a footer");
  });

  it.each(["rate limit", "network"])(
    "restores the first dashboard prompt after a %s refusal and retries only on request",
    async (failure) => {
      stashFirstPrompt(PROJECT_ID, FIRST_PROMPT);
      const posted: unknown[] = [];
      const postFirst = async (url: string, init?: RequestInit) => {
        if (!url.endsWith("/turns")) return fetchJson(url, init);
        posted.push(JSON.parse(String(init?.body)));
        if (posted.length === 1) {
          if (failure === "network") throw new TypeError("Network unavailable");
          return Response.json({ error: "try again" }, { status: 429 });
        }
        return Response.json(
          { accepted: true, requestId: "8c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f" },
          { status: 202 },
        );
      };
      const empty = { ...failedTurn(), events: [], lastSeq: 0, jobs: jobView([]) };
      const pane = (
        <StrictMode>
          <LiveChatPane
            projectId={PROJECT_ID}
            sessionId={SESSION_ID}
            log={empty}
            fetchJson={postFirst}
          />
        </StrictMode>
      );
      const view = render(pane);

      await screen.findByRole("alert");
      await waitFor(() => {
        expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(FIRST_PROMPT.text);
        expect(screen.getByRole("button", { name: "Remove pasted.png" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "Remove flow.webm" })).toBeEnabled();
      });
      expect(await screen.findByRole("button", { name: "Model" })).toHaveTextContent(
        "Claude Opus 5",
      );
      expect(screen.getByRole("img", { name: "flow.webm" })).toHaveAttribute(
        "src",
        "data:image/jpeg;base64,/9j/AAAA",
      );
      expect(view.container.querySelector("video")).toBeNull();
      view.rerender(pane);
      await act(async () => {});
      expect(posted).toEqual([
        {
          message: FIRST_PROMPT.text,
          model: FIRST_PROMPT.model,
          attachments: FIRST_PROMPT.attachments,
        },
      ]);

      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(posted).toHaveLength(2));
      expect(posted[1]).toEqual(posted[0]);
      expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      view.unmount();
      render(pane);
      await act(async () => {});
      expect(posted).toHaveLength(2);
      expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
      expect(screen.queryByRole("button", { name: "Remove flow.webm" })).not.toBeInTheDocument();
    },
  );

  it("lets a refused first dashboard prompt be edited and a reference removed before resend", async () => {
    stashFirstPrompt(PROJECT_ID, FIRST_PROMPT);
    const posted: unknown[] = [];
    const empty = { ...failedTurn(), events: [], lastSeq: 0, jobs: jobView([]) };
    render(
      <LiveChatPane
        projectId={PROJECT_ID}
        sessionId={SESSION_ID}
        log={empty}
        fetchJson={async (url, init) => {
          if (!url.endsWith("/turns")) return fetchJson(url, init);
          posted.push(JSON.parse(String(init?.body)));
          return posted.length < 3
            ? Response.json({ error: "permission required" }, { status: 403 })
            : Response.json(
                { accepted: true, requestId: "8c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f" },
                { status: 202 },
              );
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(FIRST_PROMPT.text),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Use only the video flow" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove pasted.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual({
      message: "Use only the video flow",
      model: FIRST_PROMPT.model,
      attachments: [FIRST_PROMPT.attachments[1]],
    });
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
        "Use only the video flow",
      );
      expect(screen.getByRole("button", { name: "Remove flow.webm" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Remove pasted.png" })).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posted).toHaveLength(3));
    expect(posted[2]).toEqual(posted[1]);
  });

  it("does not recover an accepted first prompt when a later transcript retry is refused", async () => {
    stashFirstPrompt(PROJECT_ID, FIRST_PROMPT);
    const posted: unknown[] = [];
    const empty = { ...failedTurn(), events: [], lastSeq: 0, jobs: jobView([]) };
    const postFirst = async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/turns")) return fetchJson(url, init);
      posted.push(JSON.parse(String(init?.body)));
      return posted.length === 1
        ? Response.json(
            { accepted: true, requestId: "8c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f" },
            { status: 202 },
          )
        : Response.json({ error: "try again" }, { status: 429 });
    };
    const view = render(
      <LiveChatPane
        projectId={PROJECT_ID}
        sessionId={SESSION_ID}
        log={empty}
        fetchJson={postFirst}
      />,
    );
    await act(async () => {});
    const events = [
      ev("user.message", { text: FIRST_PROMPT.text, attachments: FIRST_PROMPT.attachments }, 1, {
        turnId: "8c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
      }),
      ev("turn.started", { source: "user" }, 2, { turnId: "8c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f" }),
      ev("turn.failed", { reason: "sandbox_unavailable", message: "no capacity" }, 3, {
        turnId: "8c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
      }),
      ev("user.message", { text: "A later unrelated prompt" }, 4),
      ev("turn.started", { source: "user" }, 5),
      ev("turn.failed", { reason: "sandbox_unavailable", message: "no capacity" }, 6),
    ];
    view.rerender(
      <LiveChatPane
        projectId={PROJECT_ID}
        sessionId={SESSION_ID}
        log={{ ...empty, events, lastSeq: 6, jobs: jobView(events) }}
        fetchJson={postFirst}
      />,
    );
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled());
    fireEvent.click(screen.getAllByRole("button", { name: /try again/i })[1]!);
    await screen.findByRole("alert");
    await act(async () => {});
    expect(posted[1]).toEqual({ message: "A later unrelated prompt", model: FIRST_PROMPT.model });
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Remove pasted.png" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove flow.webm" })).not.toBeInTheDocument();
  });

  it("sends an accepted first dashboard media prompt once across effects and remounts", async () => {
    stashFirstPrompt(PROJECT_ID, FIRST_PROMPT);
    const posted: unknown[] = [];
    const empty = { ...failedTurn(), events: [], lastSeq: 0, jobs: jobView([]) };
    const pane = (
      <StrictMode>
        <LiveChatPane
          projectId={PROJECT_ID}
          sessionId={SESSION_ID}
          log={empty}
          fetchJson={async (url, init) => {
            if (url.endsWith("/turns")) posted.push(JSON.parse(String(init?.body)));
            return fetchJson(url, init);
          }}
        />
      </StrictMode>
    );
    const view = render(pane);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      message: FIRST_PROMPT.text,
      model: FIRST_PROMPT.model,
      attachments: FIRST_PROMPT.attachments,
    });
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Remove flow.webm" })).not.toBeInTheDocument();
    view.rerender(pane);
    view.unmount();
    render(pane);
    await act(async () => {});
    expect(posted).toHaveLength(1);
  });

  it("restores reference bytes after a refused POST and sends the same reference again", async () => {
    const browser = mediaBrowser();
    const posted: unknown[] = [];
    const postMedia = async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/turns")) return fetchJson(url, init);
      posted.push(JSON.parse(String(init?.body)));
      return posted.length === 1
        ? Response.json({ error: "try again" }, { status: 503 })
        : Response.json(
            { accepted: true, requestId: "8c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f" },
            { status: 202 },
          );
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

  it("draws no seam and no away card, however much happened since the last visit", async () => {
    // A cursor from an earlier visit, written before this was removed, sits behind a failure —
    // exactly what used to draw both. Neither belongs in the chat any more.
    window.localStorage.setItem(`nap.seen.${SESSION_ID}`, "2");

    render(<LiveChatPane sessionId={SESSION_ID} log={failedTurn()} fetchJson={fetchJson} />);

    expect(await screen.findByText(/build me a todo list/)).toBeInTheDocument();
    expect(screen.queryByText(/new since you were last here/i)).toBeNull();
    expect(screen.queryByRole("region", { name: /while you were away/i })).toBeNull();
    // Nor does it keep tracking where reading stopped.
    expect(window.localStorage.getItem(`nap.seen.${SESSION_ID}`)).toBe("2");
  });

  it("draws no job card over the conversation", async () => {
    const job = jobLog();
    const events = [
      ev("user.message", { text: "build me a todo list" }, 1),
      job.opened(),
      job.at("verification.started", { jobId: JOB_ID }),
    ];

    render(
      <LiveChatPane
        sessionId={SESSION_ID}
        log={{ ...failedTurn(), events, lastSeq: events.length, jobs: jobView(events) }}
        fetchJson={fetchJson}
      />,
    );

    expect(await screen.findByText(/build me a todo list/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /job status/i })).toBeNull();
    expect(screen.queryByText(/nothing committed yet/i)).toBeNull();
  });
});

it("shares reconciled legacy activity with composer, Context and the visible clock", async () => {
  vi.useFakeTimers();
  const onActivity = vi.fn();
  const legacyTurn = "00000000-0000-4000-8000-000000000090";
  const events = [
    ev("agent.message", { text: "Original response" }, 1),
    ev("user.message", { text: "Legacy repair" }, 2, { turnId: legacyTurn }),
    ev("turn.started", { source: "verification" }, 3, { turnId: legacyTurn }),
  ];
  const log = { ...failedTurn(), events, lastSeq: 3, jobs: jobView(events) };
  const view = render(
    <LiveChatPane
      sessionId={SESSION_ID}
      log={log}
      onActivity={onActivity}
      fetchJson={async (url, init) => {
        if (url.includes("/activity"))
          return Response.json({ sessionId: SESSION_ID, throughSeq: 3, active: false });
        return fetchJson(url, init);
      }}
    />,
  );
  try {
    expect(screen.getByRole("status", { name: "Agent is working" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.queryByRole("status", { name: "Agent is working" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
    expect(onActivity).toHaveBeenLastCalledWith({
      sessionId: SESSION_ID,
      running: false,
      idleThroughSeq: 3,
    });
    fireEvent.click(screen.getByLabelText("Context, usage not reported"));
    expect(screen.getByRole("button", { name: "Compact context" })).toBeEnabled();
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

it("wires Fix it to a normal turn without repairing on a failed test event", async () => {
  const goal = "Save notes";
  const testTurn = "00000000-0000-4000-8000-000000000099";
  const events = [
    ev("test.started", { jobId: JOB_ID, objective: goal, commitSha: "abcdef1" }, 1, {
      turnId: testTurn,
    }),
    ev(
      "test.annotation",
      {
        annotation: {
          type: "assertion",
          id: "save",
          expectation: "The saved note appears",
          result: "failed",
        },
        timeMs: 1000,
      },
      2,
      { turnId: testTurn },
    ),
    ev(
      "turn.completed",
      { commitSha: null, usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1 },
      3,
      { turnId: testTurn },
    ),
    ev(
      "test.completed",
      { jobId: JOB_ID, status: "completed", counts: { passed: 0, failed: 1, untested: 0 } },
      4,
      { turnId: testTurn },
    ),
  ];
  const log: SessionLog = { ...failedTurn(), events, lastSeq: 4, jobs: jobView(events) };
  render(<LiveChatPane sessionId={SESSION_ID} log={log} fetchJson={fetchJson} />);
  expect(turns).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Fix it" }));
  await waitFor(() => expect(turns).toHaveLength(1));
  expect(turns[0]?.message).toContain("The saved note appears");
});

it("shows app-test progress at the clicked card before any stream event arrives", async () => {
  const events = [
    ev("job.started", { jobId: JOB_ID, objective: "Save notes" }, 1),
    ev(
      "turn.completed",
      { commitSha: "abc", usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1 },
      2,
    ),
    ev("job.checkpointed", { jobId: JOB_ID, commitSha: "abc" }, 3),
    ev("job.completed", { jobId: JOB_ID, outcome: "verified" }, 4),
  ];
  let accept: ((response: Response) => void) | undefined;
  const http = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/models"))
      return Response.json({ ...MODELS, fallback: "anthropic/claude-opus-5" });
    if (url.endsWith("/tests"))
      return new Promise<Response>((resolve) => {
        accept = resolve;
      });
    return fetchJson(url, init);
  };
  const view = render(
    <LiveChatPane
      sessionId={SESSION_ID}
      log={{ ...failedTurn(), events, lastSeq: 4, jobs: jobView(events) }}
      fetchJson={http}
    />,
  );
  const button = await screen.findByRole("button", { name: "Test the app" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(screen.getByRole("status", { name: "App test progress" })).toHaveTextContent(
    "Starting app test…",
  );
  expect(screen.getByRole("button", { name: "Starting app test…" })).toBeDisabled();
  await act(async () => {
    accept?.(
      Response.json(
        { accepted: true, requestId: "e7a1c2d3-4b5a-4c6d-8e9f-0a1b2c3d4e5f" },
        { status: 202 },
      ),
    );
  });
  expect(screen.getByRole("status", { name: "App test progress" })).toHaveTextContent(
    "Starting app test…",
  );
  const started = ev(
    "test.started",
    { jobId: JOB_ID, commitSha: "abc", objective: "Save notes" },
    5,
    { turnId: "e7a1c2d3-4b5a-4c6d-8e9f-0a1b2c3d4e5f" },
  );
  view.rerender(
    <LiveChatPane
      sessionId={SESSION_ID}
      log={{ ...failedTurn(), events: [...events, started], lastSeq: 5, jobs: jobView(events) }}
      fetchJson={http}
    />,
  );
  expect(screen.getByRole("status", { name: "App test progress" })).toHaveTextContent(
    "Testing the app…",
  );
});

it.each(["openai/gpt-5.6-luna", "openai/gpt-oss-20b:free"])(
  "starts a default app test with the owner's Anthropic key when deployment default is %s",
  async (defaultModel) => {
    const allowed = [defaultModel, "anthropic/claude-sonnet-5", "anthropic/claude-opus-5"];
    const key = { platform: "anthropic", apiKey: "owner-test-key" } as const;
    const models = createApp({
      logger: createLogger({ level: "silent" }, { write: () => {} }),
      authenticate: async () => ({ userId: "owner", isAnonymous: false }),
      stream: {
        store: new InMemoryEventStore(),
        bus: new InMemoryEventBus(),
        upgradeWebSocket: async () => new Response(null),
      },
      models: {
        allowed,
        fallback: defaultModel,
        freeModel: "openai/gpt-5.6-luna",
        keys: async () => ({
          userId: "owner",
          platform: "anthropic",
          ciphertext: "sealed",
          iv: "iv",
          hint: "sk-ant-test",
          updatedAt: "2026-10-24T00:00:00Z",
        }),
      },
    });
    const submitted: unknown[] = [];
    const admitted: ReturnType<typeof resolveTurnAccess>[] = [];
    const http = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return models.request("/models");
      if (url.endsWith("/tests")) {
        const body: unknown = JSON.parse(String(init?.body));
        submitted.push(body);
        const requested =
          typeof body === "object" &&
          body !== null &&
          "model" in body &&
          typeof body.model === "string"
            ? body.model
            : undefined;
        const access = resolveTurnAccess({
          requested,
          key,
          allowed,
          defaultModel,
          freeModel: "openai/gpt-5.6-luna",
        });
        admitted.push(access);
        return access.ok
          ? Response.json(
              { accepted: true, requestId: "e7a1c2d3-4b5a-4c6d-8e9f-0a1b2c3d4e5f" },
              { status: 202 },
            )
          : Response.json({ error: access.message, code: access.code }, { status: 400 });
      }
      return fetchJson(url, init);
    };
    const events = [
      ev("job.started", { jobId: JOB_ID, objective: "Save notes" }, 1),
      ev(
        "turn.completed",
        { commitSha: "abc", usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1 },
        2,
      ),
      ev("job.checkpointed", { jobId: JOB_ID, commitSha: "abc" }, 3),
      ev("job.completed", { jobId: JOB_ID, outcome: "verified" }, 4),
    ];
    render(
      <LiveChatPane
        sessionId={SESSION_ID}
        log={{ ...failedTurn(), events, lastSeq: 4, jobs: jobView(events) }}
        fetchJson={http}
      />,
    );
    const button = await screen.findByRole("button", { name: "Test the app" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted).toEqual([{ jobId: JOB_ID, model: "anthropic/claude-sonnet-5" }]);
    expect(admitted).toEqual([{ ok: true, model: "anthropic/claude-sonnet-5", credentials: key }]);
  },
);

describe("LiveChatPane computer recovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("clears the previous session's pause before the new recovery read answers", async () => {
    const http = async (url: string, init?: RequestInit) => {
      if (url.endsWith(`/sessions/${SESSION_ID}/computer/recovery`))
        return Response.json({ stuck: true, abandonableAt: 0 });
      if (url.endsWith(`/sessions/${OTHER_SESSION_ID}/computer/recovery`))
        return new Promise<Response>(() => {});
      return fetchJson(url, init);
    };
    const log = failedTurn();
    const view = render(<LiveChatPane sessionId={SESSION_ID} log={log} fetchJson={http} />);
    await screen.findByRole("region", { name: "Computer paused" });
    const nextLog = {
      ...log,
      events: log.events.map((event) => ({ ...event, sessionId: OTHER_SESSION_ID })),
    };
    view.rerender(<LiveChatPane sessionId={OTHER_SESSION_ID} log={nextLog} fetchJson={http} />);
    expect(screen.queryByRole("region", { name: "Computer paused" })).toBeNull();
  });

  it("keeps a late abandon result out of the newly selected idle session", async () => {
    let finish: (response: Response) => void = () => {};
    const abandoning = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const http = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith(`/sessions/${SESSION_ID}/computer/recovery`))
        return Response.json({ stuck: true, abandonableAt: 0 });
      if (url.endsWith(`/sessions/${OTHER_SESSION_ID}/computer/recovery`))
        return Response.json({ stuck: false });
      if (url.endsWith(`/sessions/${SESSION_ID}/computer/abandon`)) return abandoning;
      return fetchJson(url, init);
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const log = failedTurn();
    const view = render(<LiveChatPane sessionId={SESSION_ID} log={log} fetchJson={http} />);
    fireEvent.click(await screen.findByRole("button", { name: "Abandon this computer" }));
    expect(screen.getByRole("button", { name: "Abandoning…" })).toBeDisabled();
    expect(
      http.mock.calls.some(([url, init]) => url.endsWith("/abandon") && init?.method === "POST"),
    ).toBe(true);
    const nextLog = {
      ...log,
      events: log.events.map((event) => ({ ...event, sessionId: OTHER_SESSION_ID })),
    };
    view.rerender(<LiveChatPane sessionId={OTHER_SESSION_ID} log={nextLog} fetchJson={http} />);
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Computer paused" })).toBeNull();
    await act(async () => finish(Response.json({ outcome: "abandoned" })));
    expect(screen.queryByRole("region", { name: "Computer paused" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  async function latePause(readerAt: (bottom: number) => number) {
    let answer: (response: Response) => void = () => {};
    const recovery = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const http = async (url: string, init?: RequestInit) =>
      url.endsWith("/computer/recovery") ? recovery : fetchJson(url, init);
    const log = failedTurn();
    const view = render(<LiveChatPane sessionId={SESSION_ID} log={log} fetchJson={http} />);
    await screen.findByRole("button", { name: "Model" });
    const timeline = screen.getByRole("region", { name: "Conversation" });
    let top = 0;
    Object.defineProperties(timeline, {
      scrollHeight: {
        configurable: true,
        get: () =>
          1800 + (screen.queryByRole("region", { name: "Computer paused" }) === null ? 0 : 200),
      },
      clientHeight: { configurable: true, value: 600 },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (next: number) => {
          top = next;
        },
      },
    });
    const events = [
      ...log.events,
      ev("system.notice", { level: "info", text: "Connection restored." }, 4),
    ];
    const settled = { ...log, events, lastSeq: 4, jobs: jobView(events) };
    view.rerender(<LiveChatPane sessionId={SESSION_ID} log={settled} fetchJson={http} />);
    expect(top).toBe(1200);
    top = readerAt(1200);
    await act(async () => answer(Response.json({ stuck: true, abandonableAt: 0 })));
    expect(screen.getByRole("region", { name: "Computer paused" })).toBeDefined();
    return top;
  }

  it("keeps the reader at the bottom when recovery appears after the transcript settles", async () => {
    expect(await latePause((bottom) => bottom)).toBe(1400);
  });

  it("keeps a reader's scrolled-up position when recovery appears after the transcript settles", async () => {
    expect(await latePause(() => 400)).toBe(400);
  });
});
