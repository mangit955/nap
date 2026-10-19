"use client";

import { useState } from "react";
import { useTurnSubmission } from "../chat/use-turn-submission.ts";
import { ChatPane } from "../components/chat-pane.tsx";
import { useSessionLog } from "../hooks/use-session-log.ts";

/** Mounted only by the local verification script, never by a shipped route. */
export function CompactionPreview() {
  const sessionId = "00000000-0000-4000-8000-000000000101";
  const log = useSessionLog({ sessionId, baseUrl: "ws://localhost:3036" });
  const turn = useTurnSubmission({
    sessionId,
    events: log.events,
    baseUrl: "http://localhost:3036",
  });
  const [mode, setMode] = useState("success");
  return (
    <main className="h-dvh bg-canvas text-ink">
      <div className="flex h-12 items-center gap-4 px-5 text-sm">
        <strong>Compaction verification · scripted model</strong>
        <label>
          Next summary{" "}
          <select
            aria-label="Next summary"
            value={mode}
            onChange={async (event) => {
              const value = event.target.value;
              await fetch(`http://localhost:3036/fixture/${value}`, { method: "POST" });
              setMode(value);
            }}
          >
            <option value="success">Success</option>
            <option value="fail">Fail</option>
            <option value="slow">Wait for cancellation</option>
          </select>
        </label>
      </div>
      <div className="mx-auto h-[calc(100dvh-3rem)] max-w-3xl border-x border-edge">
        <ChatPane
          events={log.events}
          jobs={log.jobs}
          loading={!log.replayed}
          pending={turn.pending}
          running={turn.running}
          error={turn.error}
          onSubmit={(message, attachments) => {
            void turn.submit(message, undefined, attachments);
          }}
          onCancel={() => {
            void turn.cancel();
          }}
        />
      </div>
    </main>
  );
}
