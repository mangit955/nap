import type { NapEvent } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

    expect(container.textContent).toContain("Running bun install");
  });

  it("puts it after everything that has already happened", () => {
    // Below the last step, not above it: the rail is a chronology, and work in flight is the
    // newest thing on it.
    render(<ChatPane events={[started, call]} running={true} />);

    const log = screen.getByRole("log", { name: /transcript/i });
    const status = screen.getByRole("status", { name: "Agent is working" });

    expect(log.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("appears before the server has acknowledged the turn at all", () => {
    // `running` is true from the click, and the gap before `turn.started` arrives is exactly
    // when a pane with nothing moving in it looks broken.
    render(<ChatPane events={[]} pending="build me a todo list" running={true} />);

    expect(screen.getByRole("status", { name: "Agent is working" })).toBeInTheDocument();
  });
});
