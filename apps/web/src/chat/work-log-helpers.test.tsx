import type { StoredEvent } from "@nap/shared/ports/event-store";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildTranscript } from "./transcript.ts";
import { entryFailed, summarizeToolGroup } from "./work-log.ts";
import { WorkEntryRow, WorkToggleRow } from "./work-log-rows.tsx";

const base = {
  sessionId: "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f",
  turnId: "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
  createdAt: "2026-08-09T12:00:00.000Z",
};

describe.each(["fold", "row"] as const)("helper work-log %s status", (layer) => {
  it.each([
    ["running", false],
    ["completed", false],
    ["failed", false],
    ["cancelled", false],
    ["completed", true],
    ["failed", true],
    ["cancelled", true],
  ] as const)("folds and renders %s, completion-only replay=%s", (outcome, orphan) => {
    const events: StoredEvent[] = orphan
      ? []
      : [
          {
            ...base,
            seq: 1,
            type: "tool.call",
            payload: {
              toolCallId: "sub",
              toolName: "run_subagent",
              input: { profile: "explore", task: "Find the routes", background: true },
            },
          },
          {
            ...base,
            seq: 2,
            type: "subagent.started",
            payload: {
              toolCallId: "sub",
              subagentId: "helper-1",
              profile: "explore",
              task: "Find the routes",
            },
          },
          {
            ...base,
            seq: 3,
            type: "tool.result",
            payload: {
              toolCallId: "sub",
              toolName: "run_subagent",
              ok: true,
              output: "Started helper helper-1.",
            },
          },
        ];
    if (outcome !== "running")
      events.push({
        ...base,
        seq: 4,
        type: "subagent.completed",
        payload: {
          subagentId: "helper-1",
          outcome,
          summary: "Helper report",
          toolCalls: 2,
          usage: { inputTokens: 100, outputTokens: 20 },
        },
      });
    const items = buildTranscript(events);
    expect(items).toHaveLength(1);
    const entry = items[0];
    if (entry?.kind !== "step") throw new Error("Missing folded helper step");
    expect(entry.helper?.outcome).toBe(outcome);
    const failed = outcome === "failed" || outcome === "cancelled";
    const summary = summarizeToolGroup([entry]);
    if (layer === "fold") {
      if (orphan) expect(entry.status).not.toBe("running");
      expect(entryFailed(entry)).toBe(failed);
      expect(summary).toEqual({ summary: "Delegated 1 task", hasFailure: failed });
      return;
    }
    render(
      <>
        <WorkEntryRow entry={entry} />
        <WorkToggleRow
          row={{
            kind: "work-toggle",
            id: "group",
            groupId: "group",
            entries: [entry],
            ...summary,
            summaryKind: "delegate",
            expanded: false,
            at: base.createdAt,
          }}
          onToggle={() => {}}
        />
      </>,
    );

    const label = orphan ? "Delegated a task" : "Find the routes";
    const name = `${label}${outcome === "running" ? ", still running" : ""}${failed ? ", tool call failed" : ""}`;
    const button = screen.getByRole("button", { name });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", {
        name: `Delegated 1 task${failed ? ", tool call failed" : ""}`,
      }),
    ).toBeInTheDocument();
    if (outcome !== "running") expect(screen.queryByText("still running")).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(
      screen.getByText(
        outcome === "running"
          ? /Search helper.*Working/
          : new RegExp(
              `Search helper.*${outcome === "completed" ? "Reported" : outcome === "cancelled" ? "Stopped" : "Failed"} after 2 steps`,
            ),
      ),
    ).toBeInTheDocument();
    if (outcome !== "running") expect(screen.getByText("Helper report")).toBeInTheDocument();
  });
});
