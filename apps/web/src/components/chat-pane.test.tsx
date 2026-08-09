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

describe("ChatPane", () => {
  it("invites a first prompt when nothing has happened yet", () => {
    render(<ChatPane events={[]} />);

    // An empty screen is an invitation to act, so it says what to do — and there is no empty
    // transcript sitting under it announcing itself to a screen reader.
    expect(screen.getByText(/describe the app you want/i)).toBeVisible();
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
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
});
