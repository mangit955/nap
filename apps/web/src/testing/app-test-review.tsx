"use client";

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { useCallback, useState } from "react";
import { z } from "zod";
import { jobView } from "../chat/job-summary.ts";
import { LiveChatPane } from "../components/chat-pane.tsx";
import { ev, SESSION_ID } from "./events.ts";
import { JOB_ID } from "./job-events.ts";

const testTurn = "00000000-0000-4000-8000-000000000099";
const repairTurn = "00000000-0000-4000-8000-000000000098";
const goal = "Save a note and find it in the list";
const prefix: StoredEvent[] = [
  ev("job.started", { jobId: JOB_ID, objective: goal }, 1),
  ev(
    "turn.completed",
    { commitSha: "abcdef1", usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1 },
    2,
  ),
  ev("job.checkpointed", { jobId: JOB_ID, commitSha: "abcdef1" }, 3),
  ev("job.completed", { jobId: JOB_ID, outcome: "verified" }, 4),
];
const modes = ["approval", "running", "passed", "failed", "untested", "interrupted", "repair"];

/** The actual live pane against a local in-memory HTTP seam. No model, API server, or sandbox. */
export function AppTestReview() {
  const [mode, setMode] = useState("approval");
  const [requests, setRequests] = useState<string[]>([]);
  const [repair, setRepair] = useState("");
  const events = [...prefix];
  const at = { turnId: testTurn };
  if (mode !== "approval") {
    events.push(
      ev("test.started", { jobId: JOB_ID, commitSha: "abcdef1", objective: goal }, 5, at),
    );
    events.push(ev("turn.started", { source: "test" }, 6, at));
    events.push(
      ev(
        "agent.message",
        {
          text: "I’ll test the main flow: enter a note, choose Save, and check that the new note appears in the list. I’ll state the expected result before each action.",
        },
        7,
        at,
      ),
    );
    events.push(
      ev(
        "test.annotation",
        {
          annotation: {
            type: "assertion",
            id: "save",
            expectation: "The new note appears in the list.",
            result: "untested",
          },
          timeMs: 0,
        },
        8,
        at,
      ),
    );
    if (mode !== "running") {
      const result =
        mode === "passed"
          ? "passed"
          : mode === "failed" || mode === "repair"
            ? "failed"
            : "untested";
      if (result !== "untested")
        events.push(
          ev(
            "test.annotation",
            {
              annotation: {
                type: "assertion",
                id: "save",
                expectation: "The new note appears in the list.",
                result,
              },
              timeMs: 1000,
            },
            9,
            at,
          ),
        );
      events.push(
        ev(
          "turn.completed",
          { commitSha: null, usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1000 },
          10,
          at,
        ),
      );
      events.push(
        ev(
          "test.completed",
          {
            jobId: JOB_ID,
            status: mode === "interrupted" ? "interrupted" : "completed",
            counts: {
              passed: result === "passed" ? 1 : 0,
              failed: result === "failed" ? 1 : 0,
              untested: result === "untested" ? 1 : 0,
            },
          },
          11,
          at,
        ),
      );
    }
    if (mode === "repair") {
      events.push(ev("user.message", { text: repair }, 12, { turnId: repairTurn }));
      events.push(ev("turn.started", { source: "user" }, 13, { turnId: repairTurn }));
    }
  }
  const cursor = events.at(-1)?.seq ?? 0;
  const fetchJson = useCallback(
    async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models"))
        return Response.json({
          models: [
            {
              id: "anthropic/claude-sonnet-5",
              label: "Claude Sonnet 5",
              free: false,
              available: true,
            },
          ],
          key: { configured: true },
          fallback: "anthropic/claude-sonnet-5",
        });
      if (url.includes("/account/api-key"))
        return Response.json({ present: true, platform: "openrouter" });
      if (url.includes("/activity?"))
        return Response.json({
          sessionId: SESSION_ID,
          throughSeq: cursor,
          active: mode === "running" || mode === "repair",
        });
      if (init?.method === "POST") {
        setRequests((current) => [...current, new URL(url).pathname]);
        if (url.endsWith("/tests")) {
          setMode("running");
          return Response.json({ accepted: true, requestId: testTurn }, { status: 202 });
        }
        if (url.endsWith("/turns")) {
          const body = z.object({ message: z.string() }).parse(JSON.parse(String(init.body)));
          setRepair(body.message);
          setMode("repair");
          return Response.json({ accepted: true, requestId: repairTurn }, { status: 202 });
        }
      }
      return Response.json({ id: url.split("/").at(-1), state: "done" });
    },
    [cursor, mode],
  );
  return (
    <main style={{ maxWidth: 820, padding: 24, margin: "auto" }}>
      <label>
        Review test state{" "}
        <select
          aria-label="Review test state"
          value={mode}
          onChange={(event) => setMode(event.currentTarget.value)}
        >
          {modes.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <p
        role="status"
        aria-label="Review requests"
        style={{ fontSize: 12, color: "var(--color-muted)", marginBlock: 10 }}
      >
        {requests.length ? requests.join(" → ") : "No requests"}
      </p>
      <div
        style={{
          height: 820,
          border: "1px solid var(--color-edge)",
          borderRadius: 20,
          overflow: "hidden",
        }}
      >
        <LiveChatPane
          sessionId={SESSION_ID}
          log={{
            events,
            status: "open",
            replayed: true,
            lastSeq: cursor,
            preview: { status: "idle" },
            changed: new Set(),
            jobs: jobView(events),
          }}
          fetchJson={fetchJson}
        />
      </div>
    </main>
  );
}
