import type { NapEvent } from "@nap/shared/events";
import type { MediaAttachment } from "@nap/shared/media";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { mediaBrowser } from "../testing/media-browser.ts";
import { ChatPane } from "./chat-pane.tsx";

const message: StoredEvent = {
  type: "agent.message",
  sessionId: "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f",
  turnId: "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
  seq: 1,
  createdAt: "2026-08-09T12:00:00.000Z",
  payload: { text: "Added App.tsx." },
} satisfies NapEvent;

const started: StoredEvent = {
  type: "turn.started",
  sessionId: message.sessionId,
  turnId: message.turnId,
  seq: 3,
  createdAt: "2026-08-09T12:00:00.000Z",
  payload: { source: "user" },
} satisfies NapEvent;

const prompt: StoredEvent = {
  type: "user.message",
  sessionId: message.sessionId,
  turnId: message.turnId,
  seq: 2,
  createdAt: message.createdAt,
  payload: { text: "build me a todo list" },
} satisfies NapEvent;

const call: StoredEvent = {
  type: "tool.call",
  sessionId: message.sessionId,
  turnId: message.turnId,
  seq: 4,
  createdAt: "2026-08-09T12:00:01.000Z",
  payload: { toolCallId: "a", toolName: "run_command", input: { command: "bun install" } },
} satisfies NapEvent;

describe("ChatPane", () => {
  it("invites a first prompt when nothing has happened yet", () => {
    render(<ChatPane events={[]} />);

    // An empty screen is an invitation to act, so it says what to do — and there is no empty
    // transcript sitting under it announcing itself to a screen reader.
    expect(screen.getByText(/describe the app you want/i)).toBeVisible();
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
  });

  it("waits with a skeleton rather than inviting a first prompt", () => {
    // The bug this exists for: a project with forty turns in it was greeted by "Describe the
    // app you want" and four examples for the second before its log arrived. The invitation is
    // the honest answer to "there are no events" and a lie about "the events are still coming".
    render(<ChatPane events={[]} loading />);

    expect(screen.getByRole("status", { name: /loading this conversation/i })).toBeInTheDocument();
    expect(screen.queryByText(/describe the app you want/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: /example prompts/i })).not.toBeInTheDocument();
  });

  it("never covers a conversation it already has", () => {
    // A reconnect mid-session must not replace what is on screen with a placeholder.
    render(<ChatPane events={[message]} loading />);

    expect(screen.getByRole("log", { name: /transcript/i })).toHaveTextContent("Added App.tsx.");
    expect(screen.queryByRole("status", { name: /loading this conversation/i })).toBeNull();
  });

  it("shows the transcript once there are events", () => {
    render(<ChatPane events={[message]} />);

    expect(screen.getByRole("log", { name: /transcript/i })).toHaveTextContent("Added App.tsx.");
    expect(screen.queryByText(/describe the app you want/i)).not.toBeInTheDocument();
  });

  it("keeps its pane landmark either way", () => {
    // The shell's own tests find the panes by role and name; losing that here would move the
    // failure to a file that has nothing to do with this change.
    const { rerender } = render(<ChatPane events={[]} />);
    expect(screen.getByRole("region", { name: "Chat" })).toBeInTheDocument();

    rerender(<ChatPane events={[message]} />);
    expect(screen.getByRole("region", { name: "Chat" })).toBeInTheDocument();
  });

  it("always offers somewhere to type", () => {
    render(<ChatPane events={[]} />);

    expect(screen.getByRole("textbox", { name: /message/i })).toBeInTheDocument();
  });

  it("shows the message the user just sent, before the log has it", () => {
    render(<ChatPane events={[]} pending="build me a todo list" />);

    expect(screen.getByText("build me a todo list")).toBeVisible();
    // Not the invitation: something *has* happened, it is simply not written down yet.
    expect(screen.queryByText(/describe the app you want/i)).not.toBeInTheDocument();
  });

  it("shows it once, not twice, while the transcript catches up", () => {
    // The pane renders both halves, so this is the last place the duplicate could appear even
    // with the hook reconciling correctly.
    const userMessage: StoredEvent = {
      type: "user.message",
      sessionId: message.sessionId,
      turnId: message.turnId,
      seq: 2,
      createdAt: message.createdAt,
      payload: { text: "build me a todo list" },
    } satisfies NapEvent;

    render(<ChatPane events={[userMessage]} pending={undefined} />);

    expect(screen.getAllByText("build me a todo list")).toHaveLength(1);
  });

  it("says the agent is working while a turn is open", () => {
    render(<ChatPane events={[started]} running={true} />);

    expect(screen.getByRole("status", { name: "Agent is working" })).toBeInTheDocument();
  });

  it("says nothing of the kind when no turn is running", () => {
    render(<ChatPane events={[message]} running={false} />);

    expect(screen.queryByRole("status", { name: "Agent is working" })).not.toBeInTheDocument();
  });

  it("names the tool call that is still out", () => {
    // The label is the reason this is not just a spinner: during the twenty-second silences a
    // turn is mostly made of, it is the only thing on screen saying what is happening.
    const { container } = render(<ChatPane events={[started, call]} running={true} />);

    expect(container.textContent).toContain("Running bun");
  });

  it("puts it after everything that has already happened", () => {
    // Below the last step, not above it: the rail is a chronology, and work in flight is the
    // newest thing on it.
    render(<ChatPane events={[started, call]} running={true} />);

    const log = screen.getByRole("log", { name: /transcript/i });
    const status = screen.getByRole("status", { name: "Agent is working" });

    expect(log.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps a clock that never goes back, from sending the prompt to the turn starting", () => {
    // Between the prompt reaching the log and `turn.started`, the runtime is acquiring a sandbox —
    // often the longest wait in a turn. The row also moves on the way: from under the optimistic
    // prompt into the transcript, which remounts it.
    const sent = Date.parse(prompt.createdAt);
    vi.useFakeTimers({ now: sent });
    try {
      const counts: number[] = [];
      const read = () => {
        const status = screen.getByRole("status", { name: "Agent is working" });
        const count = Number(/Working for (\d+)s/.exec(status.textContent ?? "")?.[1]);
        counts.push(count);
        return count;
      };
      const at = (ms: number) => new Date(sent + ms).toISOString();

      const view = render(
        <ChatPane
          events={[]}
          pending="build me a todo list"
          running
          activity={{ startedAt: undefined }}
        />,
      );
      expect(read()).toBe(0);
      act(() => vi.advanceTimersByTime(3_000));
      expect(read()).toBe(3);

      // The worker claims the request and logs the prompt.
      const logged = { ...prompt, createdAt: at(3_000) };
      const waiting = { startedAt: undefined, openedAt: logged.createdAt };
      view.rerender(<ChatPane events={[logged]} running activity={waiting} />);
      read();
      act(() => vi.advanceTimersByTime(2_000));
      read();

      // Acquiring a sandbox writes notices, and the pane re-renders on each one.
      const notice: StoredEvent = {
        ...logged,
        type: "system.notice",
        seq: 3,
        payload: { level: "info", text: "Restoring your last snapshot." },
      } satisfies NapEvent;
      view.rerender(<ChatPane events={[logged, notice]} running activity={waiting} />);
      act(() => vi.advanceTimersByTime(3_000));
      read();
      // No model has been asked anything yet.
      expect(screen.getByRole("log")).not.toHaveTextContent(/Thinking/);

      // The sandbox is up five seconds after the prompt was logged, and the server's clock starts.
      const begun = { ...started, seq: 4, createdAt: at(8_000) };
      view.rerender(
        <ChatPane
          events={[logged, notice, begun]}
          running
          activity={{ startedAt: begun.createdAt, openedAt: logged.createdAt }}
        />,
      );
      read();
      act(() => vi.advanceTimersByTime(1_000));
      expect(read()).toBe(9);

      expect(counts).toEqual([...counts].sort((a, b) => a - b));
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the server's times after a reload in the middle of a turn", () => {
    const sent = Date.parse(prompt.createdAt);
    vi.useFakeTimers({ now: sent + 20_000 });
    try {
      render(
        <ChatPane
          events={[prompt]}
          running
          activity={{ startedAt: undefined, openedAt: prompt.createdAt }}
        />,
      );

      expect(screen.getByRole("status", { name: "Agent is working" })).toHaveTextContent(
        "Working for 20s",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the next turn's clock again when its start arrives with the last one's end", () => {
    // A reconnect replays everything it missed in one batch, so one turn's end and the next one's
    // prompt can land in the same render. The row is the same row throughout and never unmounts.
    const sent = Date.parse(prompt.createdAt);
    vi.useFakeTimers({ now: sent });
    try {
      const at = (ms: number) => new Date(sent + ms).toISOString();
      const first = [prompt, started];
      const view = render(
        <ChatPane
          events={first}
          running
          activity={{ startedAt: started.createdAt, openedAt: prompt.createdAt }}
        />,
      );
      act(() => vi.advanceTimersByTime(30_000));
      const status = () => screen.getByRole("status", { name: "Agent is working" });
      expect(status()).toHaveTextContent("Working for 30s");

      const next = "8d2e3f4a-5b6c-4d7e-9f80-1a2b3c4d5e61";
      const ended: StoredEvent = {
        ...message,
        type: "turn.completed",
        seq: 4,
        createdAt: at(30_000),
        payload: {
          usage: { inputTokens: 1, outputTokens: 1 },
          durationMs: 30_000,
          commitSha: null,
        },
      } satisfies NapEvent;
      const asked = { ...prompt, turnId: next, seq: 5, createdAt: at(30_000) };
      const begun = { ...started, turnId: next, seq: 6, createdAt: at(30_000) };
      view.rerender(
        <ChatPane
          events={[...first, ended, asked, begun]}
          running
          activity={{ startedAt: begun.createdAt, openedAt: asked.createdAt }}
        />,
      );
      act(() => vi.advanceTimersByTime(1_000));

      expect(status()).toHaveTextContent("Working for 1s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps counting through a compaction for the prompt queued behind it", () => {
    // The user sent this prompt to wait for the compaction, so its end is the same wait going on.
    const sent = Date.parse(prompt.createdAt);
    vi.useFakeTimers({ now: sent });
    try {
      const at = (ms: number) => new Date(sent + ms).toISOString();
      const compaction = "9e3f4a5b-6c7d-4e8f-8a91-2b3c4d5e6f72";
      const counts: number[] = [];
      const read = () => {
        const status = screen.getByRole("status", { name: "Agent is working" });
        counts.push(Number(/Working for (\d+)s/.exec(status.textContent ?? "")?.[1]));
      };
      const compacting: StoredEvent = {
        ...message,
        type: "compaction.started",
        turnId: compaction,
        seq: 1,
        payload: { id: "k1", trigger: "manual" },
      } satisfies NapEvent;
      const opened = { startedAt: compacting.createdAt, openedAt: compacting.createdAt };
      const view = render(<ChatPane events={[compacting]} running activity={opened} />);
      act(() => vi.advanceTimersByTime(4_000));
      view.rerender(
        <ChatPane
          events={[compacting]}
          pending="next"
          pendingAfterCompaction
          running
          activity={opened}
        />,
      );
      read();
      act(() => vi.advanceTimersByTime(6_000));
      read();

      const compacted: StoredEvent[] = [
        compacting,
        {
          ...compacting,
          type: "compaction.completed",
          seq: 2,
          createdAt: at(10_000),
          payload: {
            id: "k1",
            result: { kind: "native", provider: "codex", sessionId: "n", coveredThrough: 0 },
            usage: null,
            beforeTokens: null,
            afterTokens: null,
          },
        } satisfies NapEvent,
        {
          ...compacting,
          type: "turn.completed",
          seq: 3,
          createdAt: at(10_000),
          payload: {
            usage: { inputTokens: 1, outputTokens: 1 },
            durationMs: 10_000,
            commitSha: null,
          },
        } satisfies NapEvent,
      ];
      view.rerender(
        <ChatPane
          events={compacted}
          pending="next"
          pendingAfterCompaction
          running
          activity={{ startedAt: undefined }}
        />,
      );
      read();
      act(() => vi.advanceTimersByTime(3_000));
      read();

      expect(counts.at(-1)).toBe(13);
      expect(counts).toEqual([...counts].sort((a, b) => a - b));
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a retry's clock again when the turn it was queued behind ends", () => {
    // "Try again" is offered while another turn runs, and the server queues what it sends. Once
    // that turn is over, the retry is the work being waited for.
    const sent = Date.parse(prompt.createdAt);
    vi.useFakeTimers({ now: sent });
    try {
      const at = (ms: number) => new Date(sent + ms).toISOString();
      const running = { startedAt: started.createdAt, openedAt: prompt.createdAt };
      const view = render(<ChatPane events={[prompt, started]} running activity={running} />);
      act(() => vi.advanceTimersByTime(20_000));
      view.rerender(
        <ChatPane events={[prompt, started]} pending="again" running activity={running} />,
      );
      act(() => vi.advanceTimersByTime(10_000));

      const ended: StoredEvent = {
        ...message,
        type: "turn.completed",
        seq: 4,
        createdAt: at(30_000),
        payload: {
          usage: { inputTokens: 1, outputTokens: 1 },
          durationMs: 30_000,
          commitSha: null,
        },
      } satisfies NapEvent;
      view.rerender(
        <ChatPane
          events={[prompt, started, ended]}
          pending="again"
          running
          activity={{ startedAt: undefined }}
        />,
      );
      act(() => vi.advanceTimersByTime(1_000));

      expect(screen.getByRole("status", { name: "Agent is working" })).toHaveTextContent(
        "Working for 1s",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing is running under a turn that has finished while its checks run", () => {
    const completed: StoredEvent = {
      ...message,
      type: "turn.completed",
      seq: 5,
      payload: { usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 4_000, commitSha: null },
    } satisfies NapEvent;
    render(<ChatPane events={[prompt, started, message, completed]} running />);

    expect(screen.queryByRole("status", { name: "Agent is working" })).toBeNull();
    expect(screen.getByRole("log")).not.toHaveTextContent(/Thinking/);
    // The turn can still be stopped: the composer reads the wider flag.
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("appears before the server has acknowledged the turn at all", () => {
    // `running` is true from the click, and the gap before `turn.started` arrives is exactly
    // when a pane with nothing moving in it looks broken.
    render(<ChatPane events={[]} pending="build me a todo list" running={true} />);

    expect(screen.getByRole("status", { name: "Agent is working" })).toBeInTheDocument();
  });
});

it("labels only the optimistic message queued after compaction", () => {
  const { rerender } = render(
    <ChatPane events={[message]} pending="Next request" pendingAfterCompaction running />,
  );
  expect(screen.getByText("Queued after compaction")).toBeVisible();
  expect(screen.getByText("Next request")).toBeVisible();
  rerender(<ChatPane events={[message]} />);
  expect(screen.queryByText("Queued after compaction")).toBeNull();
});

it("places the icon-only context control inside the composer beside Send and Stop", () => {
  const { rerender } = render(<ChatPane events={[message]} />);
  const composer = screen.getByRole("group", { name: "Message composer" });
  const context = within(composer).getByLabelText("Context, usage not reported");
  expect(context.textContent).toBe("?");
  expect(context.closest("details")?.nextElementSibling).toBe(
    screen.getByRole("button", { name: "Send" }),
  );
  rerender(<ChatPane events={[message]} running />);
  expect(context.closest("details")?.nextElementSibling).toBe(
    screen.getByRole("button", { name: "Stop" }),
  );
});

it("attaches a collapsible queue above the composer until the exact pending request clears", () => {
  const attachments: MediaAttachment[] = [
    {
      kind: "image",
      name: "reference.jpg",
      frames: [{ data: "AAAA", mediaType: "image/jpeg", timestamp: 0 }],
    },
  ];
  const { rerender } = render(
    <ChatPane
      events={[message]}
      pending="Next request"
      pendingAttachments={attachments}
      pendingAfterCompaction
      running
    />,
  );
  const queue = screen.getByRole("group", { name: "Queued messages" });
  const composer = screen.getByRole("group", { name: "Message composer" });
  expect(queue.nextElementSibling).toBe(composer);
  expect(within(queue).getByText("Next request")).toBeVisible();
  expect(within(queue).getByRole("img", { name: "reference.jpg" })).toHaveAttribute(
    "src",
    "data:image/jpeg;base64,AAAA",
  );
  expect(screen.getAllByText("Next request")).toHaveLength(1);
  expect(screen.getByRole("log")).not.toHaveTextContent("Next request");
  const disclosure = within(queue).getByLabelText("Queued messages, 1");
  fireEvent.click(disclosure);
  expect(within(queue).getByText("Next request")).not.toBeVisible();
  fireEvent.click(disclosure);
  expect(within(queue).getByText("Next request")).toBeVisible();
  // A finished compaction does not identify the next request or settle its queue display.
  rerender(
    <ChatPane events={[message]} pending="Next request" pendingAfterCompaction running={false} />,
  );
  expect(screen.getByRole("group", { name: "Queued messages" })).toBeVisible();
  rerender(<ChatPane events={[message]} pending="Ordinary request" />);
  expect(screen.queryByRole("group", { name: "Queued messages" })).toBeNull();
  expect(screen.getByText("Ordinary request")).toBeVisible();
});

describe("a file dragged over the chat", () => {
  const dragging = (files: File[] = []) => ({ dataTransfer: { types: ["Files"], files } });
  const overlay = () => screen.queryByText("Drop files to attach");

  it("says the chat will take it, and attaches it when it is dropped", async () => {
    const media = mediaBrowser();
    try {
      render(<ChatPane events={[message]} />);
      const over = screen.getByText("Added App.tsx.");

      fireEvent.dragEnter(over, dragging());
      expect(overlay()).toBeInTheDocument();

      fireEvent.drop(over, dragging([new File(["small"], "reference.png", { type: "image/png" })]));
      expect(overlay()).toBeNull();
      await screen.findByRole("button", { name: "Remove reference.png" });
    } finally {
      media.restore();
    }
  });

  it("clears when the drag leaves, and comes back as soon as it moves over the chat again", () => {
    // A leave with no `relatedTarget` is also what WebKit fires crossing between two children,
    // with the pointer still inside — so the next move has to say so again.
    render(<ChatPane events={[message]} />);
    const over = screen.getByText("Added App.tsx.");

    fireEvent.dragEnter(over, dragging());
    fireEvent.dragLeave(over, { ...dragging(), relatedTarget: null });
    expect(overlay()).toBeNull();

    fireEvent.dragOver(over, dragging());
    expect(overlay()).toBeInTheDocument();
  });

  it("offers nothing while a turn is running, which cannot take an attachment", () => {
    render(<ChatPane events={[started, call]} running />);

    fireEvent.dragEnter(screen.getByRole("log"), dragging());

    expect(overlay()).toBeNull();
  });
});
