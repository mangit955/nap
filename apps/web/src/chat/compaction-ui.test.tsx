import type { MediaAttachment } from "@nap/shared/media";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatTranscript } from "./chat-transcript.tsx";
import { buildTranscript } from "./transcript.ts";

const envelope = { sessionId: "s", turnId: "manual", createdAt: "2026-10-20T12:00:00Z" };
const start: StoredEvent = {
  ...envelope,
  seq: 1,
  type: "compaction.started",
  payload: { id: "c", trigger: "manual" },
};
const complete: StoredEvent = {
  ...envelope,
  seq: 2,
  createdAt: "2026-10-20T12:00:03Z",
  type: "compaction.completed",
  payload: {
    id: "c",
    beforeTokens: 1200,
    afterTokens: 2400,
    usage: { inputTokens: 8000, outputTokens: 200 },
    result: {
      kind: "api",
      checkpoint: {
        summary: "Keep keyboard navigation. <script>untrusted</script>",
        coveredThrough: 0,
        tail: [],
      },
    },
  },
};
function show(events: StoredEvent[], retry = vi.fn()) {
  return render(<ChatTranscript items={buildTranscript(events)} onRetry={retry} />);
}

describe("compaction presentation", () => {
  it("preserves structured provenance and completion data, including a size increase", () => {
    const items = buildTranscript([start, complete]);
    expect(items).toEqual([
      expect.objectContaining({
        kind: "compaction",
        key: 1,
        trigger: "manual",
        startedAt: start.createdAt,
        finishedAt: complete.createdAt,
        status: "completed",
        ...complete.payload,
      }),
    ]);
    show([start, complete]);
    expect(screen.getByRole("status")).toHaveTextContent("Context compacted 1.2Kto2.4K tokens");
    expect(screen.queryByText(/Manual|Summary call|Keep keyboard navigation/)).toBeNull();
    expect(screen.queryByText("Compaction details")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByText(/saved|reduction/i)).toBeNull();
  });

  it("shortens the counts the way the context meter's neighbours do", () => {
    show([
      start,
      { ...complete, payload: { ...complete.payload, beforeTokens: 294_123, afterTokens: 12_634 } },
    ]);
    expect(screen.getByRole("status")).toHaveTextContent("Context compacted 294Kto12.6K tokens");
  });

  it("does not infer a trigger or counts from terminal-only native replay", () => {
    const terminal: StoredEvent = {
      ...complete,
      payload: {
        ...complete.payload,
        result: { kind: "native", provider: "codex", sessionId: "native", coveredThrough: 0 },
        beforeTokens: null,
        afterTokens: null,
        usage: null,
      },
    };
    expect(buildTranscript([terminal])[0]).toMatchObject({ trigger: null, startedAt: null });
    show([terminal]);
    expect(screen.getByRole("status")).toHaveTextContent(/^Context compacted$/);
    expect(screen.queryByText(/Manual|Automatic|tokens/)).toBeNull();
  });

  it.each([false, true])("consolidates manual terminal failure, cancelled=%s", (cancelled) => {
    const retry = vi.fn();
    const failure: StoredEvent = {
      ...envelope,
      seq: 2,
      type: "compaction.failed",
      payload: { id: "c", message: "Summary request ended", cancelled, usage: null },
    };
    const terminal: StoredEvent = {
      ...envelope,
      seq: 3,
      type: "turn.failed",
      payload: { reason: cancelled ? "cancelled" : "internal", message: "Summary request ended" },
    };
    show([start, failure, terminal], retry);
    expect(
      screen.getAllByText(cancelled ? "Context compaction stopped" : "Context compaction failed"),
    ).toHaveLength(1);
    expect(screen.getAllByText("Summary request ended")).toHaveLength(1);
    if (cancelled) {
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(screen.getByText("Context compaction stopped")).not.toHaveClass("text-danger");
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(retry).toHaveBeenCalledExactlyOnceWith("/compact");
    }
  });

  it("settles an interrupted start neutrally on cancellation without reopening duplicate starts", () => {
    const end: StoredEvent = {
      ...envelope,
      seq: 2,
      type: "turn.failed",
      payload: { reason: "cancelled", message: "Stopped" },
    };
    expect(buildTranscript([start, end, { ...start, seq: 3 }])[0]).toMatchObject({
      status: "failed",
      cancelled: true,
      finishedAt: end.createdAt,
      trigger: "manual",
    });
  });

  it.each([false, true])(
    "consolidates terminal-only failures without inventing provenance, cancelled=%s",
    (cancelled) => {
      show([
        {
          ...envelope,
          seq: 2,
          type: "compaction.failed",
          payload: { id: "c", message: "Summary request ended", cancelled, usage: null },
        },
        {
          ...envelope,
          seq: 3,
          type: "turn.failed",
          payload: {
            reason: cancelled ? "cancelled" : "internal",
            message: "Summary request ended",
          },
        },
      ]);
      expect(screen.getAllByText("Summary request ended")).toHaveLength(1);
      expect(
        screen.queryByText(/The agent stopped partway through|You stopped this turn/),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(screen.queryByText(/Manual|Automatic/)).toBeNull();
      expect(
        screen.getByText(cancelled ? "Context compaction stopped" : "Context compaction failed"),
      ).toBeVisible();
    },
  );

  it("consolidates immediate automatic cancellation with differing cancellation messages", () => {
    show([
      { ...envelope, seq: 0, type: "user.message", payload: { text: "Make a form" } },
      { ...start, payload: { ...start.payload, trigger: "automatic" } },
      {
        ...envelope,
        seq: 2,
        type: "compaction.failed",
        payload: {
          id: "c",
          message: "Compaction cancelled. Previous context was kept.",
          cancelled: true,
          usage: null,
        },
      },
      {
        ...envelope,
        seq: 3,
        type: "turn.failed",
        payload: { reason: "cancelled", message: "The turn was cancelled." },
      },
    ]);
    expect(screen.getByText("Context compaction stopped")).toBeVisible();
    expect(screen.queryByText("You stopped this turn.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByText("Automatic")).toBeNull();
  });

  it.each(["internal", "budget_exceeded"] as const)(
    "retains the ordinary automatic request and recovery policy for %s",
    (reason) => {
      const retry = vi.fn();
      const attachments: MediaAttachment[] = [
        {
          kind: "image",
          name: "reference.jpg",
          frames: [{ timestamp: 0, mediaType: "image/jpeg", data: "aGVsbG8=" }],
        },
      ];
      show(
        [
          {
            ...envelope,
            seq: 0,
            type: "user.message",
            payload: { text: "Make this form", attachments },
          },
          { ...start, payload: { ...start.payload, trigger: "automatic" } },
          {
            ...envelope,
            seq: 2,
            type: "compaction.failed",
            payload: { id: "c", message: "Summary request ended", cancelled: false, usage: null },
          },
          {
            ...envelope,
            seq: 3,
            type: "turn.failed",
            payload: { reason, message: "Summary request ended" },
          },
        ],
        retry,
      );
      expect(screen.getAllByText("Summary request ended")).toHaveLength(1);
      if (reason === "internal") {
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(retry).toHaveBeenCalledExactlyOnceWith("Make this form", attachments);
      } else {
        expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
        expect(screen.getByText(/Ask for a smaller piece of it/)).toBeVisible();
      }
    },
  );

  it.each(["different-message", "visible-progress", "usage-progress"] as const)(
    "keeps a later independent failure after automatic fallback: %s",
    (progress) => {
      const events: StoredEvent[] = [
        { ...envelope, seq: 0, type: "user.message", payload: { text: "Make a form" } },
        { ...start, payload: { ...start.payload, trigger: "automatic" } },
        {
          ...envelope,
          seq: 2,
          type: "compaction.failed",
          payload: { id: "c", message: "Summary request ended", cancelled: false, usage: null },
        },
      ];
      if (progress === "visible-progress")
        events.push({
          ...envelope,
          seq: 3,
          type: "agent.message",
          payload: { text: "Continuing with previous context." },
        });
      if (progress === "usage-progress")
        events.push({
          ...envelope,
          seq: 3,
          type: "context.usage",
          payload: {
            inputTokens: 4000,
            budgetTokens: 8000,
            windowTokens: null,
            source: "estimated",
          },
        });
      events.push({
        ...envelope,
        seq: 4,
        type: "turn.failed",
        payload: {
          reason: "internal",
          message:
            progress === "different-message" ? "Workspace disconnected" : "Summary request ended",
        },
      });
      const retry = vi.fn();
      show(events, retry);
      expect(screen.getByText("The agent stopped partway through.")).toBeVisible();
      expect(screen.getByText("Context compaction failed")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(retry).toHaveBeenCalledExactlyOnceWith("Make a form");
    },
  );

  it("keeps ordinary request failures and their exact retry separate", () => {
    const retry = vi.fn();
    show(
      [
        start,
        complete,
        {
          ...envelope,
          turnId: "other",
          seq: 3,
          type: "user.message",
          payload: { text: "Fix the form" },
        },
        {
          ...envelope,
          turnId: "other",
          seq: 4,
          type: "turn.failed",
          payload: { reason: "internal", message: "Disconnected" },
        },
      ],
      retry,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledExactlyOnceWith("Fix the form");
    expect(screen.getByText(/^Context compacted/)).toBeVisible();
  });

  it("keeps one active row through duplicate starts, without naming its trigger", () => {
    const automatic: StoredEvent = {
      ...start,
      payload: { ...start.payload, trigger: "automatic" },
    };
    show([automatic, { ...automatic, seq: 2 }]);
    expect(screen.getAllByText("Compacting context")).toHaveLength(1);
    expect(screen.queryByText("Automatic")).toBeNull();
  });
});
