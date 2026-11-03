import { type NapEvent, NapEventSchema, type NapEventType } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTranscript } from "./chat-transcript.tsx";
import { buildTranscript } from "./transcript.ts";

/**
 * A proposed plan as the person meets it: from the log, through the same fold the pane uses, into
 * the card. Queried by role and accessible name, because the card is a form somebody must be able
 * to find and operate without seeing it.
 */

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const PLAN_TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const NEXT_TURN = "8c7b6a59-4d3e-4f21-9a8b-7c6d5e4f3a2b";

let seq = 1;

function ev<T extends NapEventType>(
  type: T,
  payload: Extract<NapEvent, { type: T }>["payload"],
  turnId = PLAN_TURN,
): StoredEvent {
  const event = {
    type,
    sessionId: SESSION,
    turnId,
    seq: seq++,
    createdAt: "2026-11-03T12:00:00.000Z",
    payload,
  } as StoredEvent;
  NapEventSchema.parse(event);
  return event;
}

const planned = (): StoredEvent[] => [
  ev("user.message", { text: "add a dark theme", plan: { intent: "propose" } }),
  ev("turn.started", { source: "user" }),
  ev("plan.proposed", {
    toolCallId: "plan",
    title: "Dark theme",
    plan: "1. Add **colour tokens**\n2. Add a toggle",
  }),
  ev("turn.completed", {
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 1200,
    commitSha: null,
    awaiting: "plan_approval",
  }),
];

function show(events: StoredEvent[], options: { busy?: boolean } = {}) {
  const approve = vi.fn();
  const propose = vi.fn();
  render(
    <ChatTranscript
      items={buildTranscript(events)}
      running={options.busy ?? false}
      planActions={{ approve, propose }}
    />,
  );
  return { approve, propose, card: screen.getByRole("region", { name: /Dark theme/ }) };
}

afterEach(() => {
  seq = 1;
});

describe("a proposed plan", () => {
  it("renders the plan's title and its Markdown body", () => {
    const { card } = show(planned());
    expect(within(card).getByRole("heading", { name: /Dark theme/ })).toBeInTheDocument();
    expect(within(card).getByText("colour tokens").tagName).toBe("STRONG");
    expect(within(card).getByText(/waiting for your approval/i)).toBeInTheDocument();
  });

  it("approves the plan its turn proposed", () => {
    const { approve, card } = show(planned());
    fireEvent.click(within(card).getByRole("button", { name: "Approve plan" }));
    expect(approve).toHaveBeenCalledWith(PLAN_TURN);
  });

  it("sends requested changes as the next plan mode message", () => {
    const { propose, approve, card } = show(planned());
    fireEvent.click(within(card).getByRole("button", { name: "Request changes" }));
    const box = within(card).getByRole("textbox", { name: "What should change?" });
    expect(within(card).getByRole("button", { name: "Send changes" })).toBeDisabled();
    fireEvent.change(box, { target: { value: "keep the light theme as default" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send changes" }));
    expect(propose).toHaveBeenCalledWith("keep the light theme as default");
    expect(approve).not.toHaveBeenCalled();
  });

  it("moves focus into the box when changes are requested, and back when they are cancelled", () => {
    const { card } = show(planned());
    fireEvent.click(within(card).getByRole("button", { name: "Request changes" }));
    expect(document.activeElement).toBe(
      within(card).getByRole("textbox", { name: "What should change?" }),
    );
    fireEvent.click(within(card).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(
      within(card).getByRole("button", { name: "Request changes" }),
    );
  });

  it("offers nothing while a message is on its way, before the log has it", () => {
    const approve = vi.fn();
    render(
      <ChatTranscript
        items={buildTranscript(planned())}
        pending
        planActions={{ approve, propose: vi.fn() }}
      />,
    );
    const card = screen.getByRole("region", { name: /Dark theme/ });
    expect(within(card).getByRole("button", { name: "Approve plan" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Request changes" })).toBeDisabled();
  });

  it("offers nothing while a turn is running", () => {
    const { card } = show(planned(), { busy: true });
    expect(within(card).getByRole("button", { name: "Approve plan" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Request changes" })).toBeDisabled();
  });

  it.each([
    [
      "approved",
      () =>
        ev(
          "user.message",
          { text: "Approved.", plan: { intent: "approve", planTurnId: PLAN_TURN } },
          NEXT_TURN,
        ),
      /Approved/,
    ],
    [
      "revised",
      () => ev("user.message", { text: "smaller", plan: { intent: "propose" } }, NEXT_TURN),
      /Changes requested/,
    ],
    ["superseded", () => ev("user.message", { text: "something else" }, NEXT_TURN), /Set aside/],
  ])("is drawn settled once %s, with nothing left to click", (_status, next, label) => {
    const events = planned();
    const { card } = show([...events, next()]);
    expect(within(card).getByText(label)).toBeInTheDocument();
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("is drawn unfinished when the turn that proposed it failed", () => {
    const events = planned().slice(0, 3);
    events.push(ev("turn.failed", { reason: "cancelled", message: "The turn was cancelled." }));
    const { card } = show(events);
    expect(within(card).getByText(/never finished/i)).toBeInTheDocument();
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("marks the prompt that asked for it, and the prompt that approved it, in words", () => {
    show([
      ...planned(),
      ev(
        "user.message",
        { text: "Approved.", plan: { intent: "approve", planTurnId: PLAN_TURN } },
        NEXT_TURN,
      ),
    ]);
    expect(screen.getByText("Plan mode")).toBeInTheDocument();
    expect(screen.getByText("Approved plan")).toBeInTheDocument();
  });
});
