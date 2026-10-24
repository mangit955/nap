"use client";

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { useState } from "react";
import { ComputerPane } from "../computer/computer-pane.tsx";

const base = {
  sessionId: "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77",
  turnId: "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b",
  createdAt: "2026-10-24T00:00:00Z",
};
const frames: StoredEvent[] = [3, 6].map((seq) => ({
  ...base,
  seq,
  type: "computer.screenshot",
  payload: { toolCallId: `screen${seq}`, key: "fixture", width: 1024, height: 768 },
}));

/** Render-only fixture. Image requests are supplied by the review browser, with no API or turn. */
export function ComputerReview() {
  const [state, setState] = useState("live");
  const [selected, setSelected] = useState<number | null>(null);
  const events: StoredEvent[] =
    state === "waiting"
      ? []
      : state === "starting"
        ? [
            {
              ...base,
              createdAt: new Date(Date.now() - 10000).toISOString(),
              seq: 7,
              type: "computer.status",
              payload: { toolCallId: "screen", state: "starting" },
            },
          ]
        : state === "failed"
          ? [
              {
                ...frames[0],
                ...base,
                seq: 999,
                type: "computer.screenshot",
                payload: { toolCallId: "failed", key: "fixture", width: 1024, height: 768 },
              },
            ]
          : frames;
  return (
    <main style={{ padding: 24, maxWidth: 1200, margin: "auto" }}>
      <label>
        Review state{" "}
        <select
          aria-label="Review state"
          value={state}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setState(value);
            setSelected(value === "history" ? 3 : value === "empty" ? 0 : null);
          }}
        >
          {["live", "history", "empty", "waiting", "starting", "failed"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <section
        style={{
          height: "min(820px, calc(100dvh - 110px))",
          marginTop: 18,
          border: "1px solid var(--color-edge)",
          borderRadius: 16,
          overflow: "hidden",
        }}
      >
        <div role="tablist" aria-label="Review panel">
          <button type="button" role="tab" aria-selected="true">
            Computer
          </button>
        </div>
        <div style={{ height: "calc(100% - 24px)" }}>
          <ComputerPane events={events} selectedSeq={selected} onSeek={setSelected} />
        </div>
      </section>
    </main>
  );
}
