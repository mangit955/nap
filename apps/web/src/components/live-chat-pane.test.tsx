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
 * The two hooks are mocked because one opens a WebSocket and the other posts over the network;
 * nothing in the `web` project can do either. What is left is exactly the wiring.
 */

import type { NapEvent, NapEventType } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const submit = vi.fn();
const events: StoredEvent[] = [];

vi.mock("../hooks/use-event-stream.ts", () => ({
  useEventStream: () => ({ events, status: "open" }),
}));

vi.mock("../chat/use-turn-submission.ts", () => ({
  useTurnSubmission: () => ({
    submit,
    cancel: vi.fn(),
    pending: undefined,
    running: false,
    error: undefined,
  }),
}));

const { LiveChatPane } = await import("./chat-pane.tsx");

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

function ev<T extends NapEventType>(
  type: T,
  payload: Extract<NapEvent, { type: T }>["payload"],
  seq: number,
) {
  return {
    type,
    sessionId: SESSION,
    turnId: TURN,
    seq,
    createdAt: "2026-08-09T12:00:00.000Z",
    payload,
  } as StoredEvent;
}

beforeEach(() => {
  submit.mockClear();
  events.length = 0;
  events.push(
    ev("user.message", { text: "build me a todo list" }, 1),
    ev("turn.started", {}, 2),
    ev("turn.failed", { reason: "sandbox_unavailable", message: "no capacity" }, 3),
  );
});

describe("LiveChatPane", () => {
  it("sends a failed turn's message again when the retry is pressed", () => {
    render(<LiveChatPane sessionId={SESSION} />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    // Through `submit`, not some second path: a retry is an ordinary turn and has to be subject
    // to the same rate limit and the same optimistic message as anything typed into the box.
    // It carries the chosen model too — retrying on a different one silently is the worst
    // version of this control, since the turn that failed and the turn that replaces it would
    // cost different amounts for no stated reason.
    expect(submit).toHaveBeenCalledWith("build me a todo list", undefined);
  });
});
