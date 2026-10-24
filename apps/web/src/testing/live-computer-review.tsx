"use client";

import { ComputerInputSchema } from "@nap/shared/computer-access";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { useState } from "react";
import { AppTestResult } from "../computer/app-test-cards.tsx";
import type { AppTestState } from "../computer/app-test-state.ts";
import { ComputerPane } from "../computer/computer-pane.tsx";
import { RecordingNavigation } from "../computer/recording-navigation.tsx";
import { type RecordingView, RecordingViewer } from "../computer/recording-viewer.tsx";
import type { FetchJson } from "../files/use-project-files.ts";

const events = [3, 6].map<StoredEvent>((seq) => ({
  type: "computer.screenshot",
  sessionId: "fixture",
  turnId: "fixture",
  seq,
  createdAt: "2026-10-24T00:00:00Z",
  payload: { toolCallId: `screen${seq}`, key: "fixture", width: 1024, height: 768 },
}));
const transport: FetchJson = async (url, init) => {
  if (url.endsWith("/input")) {
    const input = ComputerInputSchema.parse(
      JSON.parse(typeof init?.body === "string" ? init.body : "null"),
    );
    return Response.json({ applied: input.actions.length });
  }
  return Response.json(
    url.endsWith("/stream")
      ? { url: "ws://127.0.0.1:43179/stream", password: "local-fixture", width: 1024, height: 768 }
      : init?.method === "POST"
        ? { grant: "local-fixture-grant", expiresAt: Date.now() + 60000 }
        : { available: true },
  );
};
const videoUrl =
  "http://localhost:43180/sessions/00000000-0000-4000-8000-000000000001/tests/00000000-0000-4000-8000-000000000002/recording";
const test: AppTestState = {
  turnId: "fixture",
  jobId: "fixture",
  objective: "Inspect the local capture",
  status: "completed",
  assertions: [],
  annotations: [
    { timeMs: 0, annotation: { type: "setup", description: "Open the local X11 fixture" } },
    {
      timeMs: 200,
      annotation: { type: "test_start", id: "close", description: "Close the focused window" },
    },
    {
      timeMs: 400,
      annotation: {
        type: "assertion",
        id: "closed",
        expectation: "The focused window closes",
        result: "passed",
      },
    },
  ],
  recording: {
    state: "available",
    key: "fixture",
    durationMs: 1000,
    width: 1024,
    height: 768,
    interrupted: false,
  },
  counts: { passed: 1, failed: 0, untested: 0 },
};
const recording: RecordingView = {
  title: test.objective ?? "Local capture",
  videoUrl,
  downloadUrl: `${videoUrl}?download=1`,
  annotations: test.annotations,
  counts: test.counts,
};

export default function LiveViewReview() {
  const [selected, seek] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(false);
  const [watch, setWatch] = useState(false);
  return (
    <main style={{ height: "100dvh", padding: 16, display: "flex", flexDirection: "column" }}>
      <header
        style={{
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          alignItems: "center",
          fontSize: 12,
          padding: 8,
        }}
      >
        <h1>Computer</h1>
        <p>Local raw RFB and fake owner input. No cloud or model.</p>
        <button type="button" onClick={() => setBusy(!busy)}>
          {busy ? "End turn fixture" : "Start turn fixture"}
        </button>
        <button type="button" onClick={() => fetch("http://127.0.0.1:43179/close")}>
          Disconnect fixture
        </button>
        <button type="button" onClick={() => setMode(!mode)}>
          Show recording fixture
        </button>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        {mode ? (
          <RecordingNavigation.Provider value={() => setWatch(true)}>
            <AppTestResult test={test} running={false} />
          </RecordingNavigation.Provider>
        ) : (
          <ComputerPane
            events={events}
            selectedSeq={selected}
            onSeek={seek}
            sessionId="fixture"
            sandboxId="fixture-vm"
            projectId="fixture-project"
            busy={busy}
            fetchJson={transport}
          />
        )}
      </div>
      {watch && <RecordingViewer recording={recording} onClose={() => setWatch(false)} />}
    </main>
  );
}
