"use client";

import type { ProjectSummaryPayload } from "@nap/shared/projects-protocol";
import { Files, Globe, RotateCcw } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { ChatTranscript } from "../chat/chat-transcript.tsx";
import type { JobSummary } from "../chat/job-summary.ts";
import type { TranscriptItem } from "../chat/transcript.ts";
import { Sidebar } from "../dashboard/sidebar.tsx";
import { BrowserToolbar } from "../workspace/browser-toolbar.tsx";
import { WorkspaceHeader } from "../workspace/workspace-header.tsx";
import { BookingPreview } from "./booking-preview.tsx";
import { useSpaceScale } from "./use-space-scale.ts";

export type DemoStage = "prompt" | "building" | "ready";
const SPACE: CSSProperties & { "--space-w": number; "--space-h": number } = {
  "--space-w": 1440,
  "--space-h": 900,
};
const noAction = () => {};
const SESSION = {
  projectId: "d3d98880-8c73-4e73-94ee-c82d4c720144",
  name: "Highland stays",
  status: "ready",
  sandboxId: "demo-booking",
  updatedAt: "2026-10-25T12:00:00.000Z",
  sessionIds: [],
} satisfies ProjectSummaryPayload;
export const BOOKING_PROMPT =
  "Build a cabin booking app for a quiet weekend in the Highlands. Let me choose a date, change the length of stay, and reserve the cabin.";
const PROMPT: TranscriptItem = { kind: "message", key: 1, from: "user", text: BOOKING_PROMPT };
const RESPONSE: TranscriptItem = {
  kind: "message",
  key: 2,
  from: "agent",
  text: "I'll build the booking page with a date picker, live pricing, and a reservation confirmation. The preview will run on the right.",
};
const FINISHED: TranscriptItem = {
  kind: "message",
  key: 5,
  from: "agent",
  text: "The booking app is ready. Choose an arrival date and a length of stay, then try the reservation flow in the preview. Typecheck and production build passed.",
};

export function SessionPreview({ stage }: { stage: DemoStage }) {
  const host = useRef<HTMLFieldSetElement>(null);
  useSpaceScale(host, 1440);
  const [replayState, setReplayState] = useState<{ source: DemoStage; phase: DemoStage } | null>(
    null,
  );
  const manualStage = replayState?.source === stage ? replayState.phase : null;
  const [view, setView] = useState<"preview" | "code">("preview");
  const [mobileView, setMobileView] = useState<"session" | "preview">("preview");
  const [bookingVersion, setBookingVersion] = useState(0);
  useEffect(() => {
    setReplayState((current) => (current?.source !== stage ? null : current));
  }, [stage]);
  useEffect(() => {
    if (manualStage === null || manualStage === "ready") return;
    const timer = setTimeout(
      () =>
        setReplayState({ source: stage, phase: manualStage === "prompt" ? "building" : "ready" }),
      manualStage === "prompt" ? 700 : 1100,
    );
    return () => clearTimeout(timer);
  }, [manualStage, stage]);
  const phase = manualStage ?? stage;
  const items: TranscriptItem[] = [PROMPT];
  if (phase !== "prompt") {
    items.push(
      RESPONSE,
      {
        kind: "files",
        key: 3,
        files: [
          {
            path: "src/App.tsx",
            changeType: "created",
            diff: "+const total = nights * 195;\n+<button onClick={() => setConfirmed(true)}>Reserve your quiet</button>",
            added: 142,
            removed: 0,
          },
          {
            path: "src/index.css",
            changeType: "created",
            diff: "+.booking { background: #f3f0e9; color: #263c31; }",
            added: 86,
            removed: 0,
          },
        ],
      },
      {
        kind: "step",
        key: 4,
        at: "2026-10-25T12:00:00.000Z",
        toolCallId: "demo-build",
        toolName: "run_command",
        input: { command: "npm run typecheck && npm run build" },
        status: phase === "ready" ? "ok" : "running",
        output: phase === "ready" ? "Typecheck passed. Production build completed." : "",
        streamed:
          phase === "ready"
            ? "✓ Typecheck passed\n✓ Production build completed"
            : "Building the booking flow…",
        files: [],
      },
    );
    if (phase === "ready") items.push(FINISHED);
  }
  const job: JobSummary = {
    phase: phase === "ready" ? "verified" : "working",
    phaseLabel: phase === "ready" ? "Verified" : "Working",
    open: phase !== "ready",
  };
  const replay = () => {
    setReplayState({ source: stage, phase: "prompt" });
    setView("preview");
    setBookingVersion((version) => version + 1);
  };
  return (
    <div className="lp-session-container">
      <fieldset
        ref={host}
        className="lp-session-shell"
        aria-label="Interactive Nap session demo building a cabin booking app"
        data-phase={phase}
      >
        <div
          className="lp-session-stage dashboard-preview"
          style={SPACE}
          data-mobile-view={mobileView}
        >
          <div className="lp-session-sidebar" inert aria-hidden="true">
            <Sidebar
              persistScroll={false}
              name="You"
              email={undefined}
              recents={[SESSION]}
              activeProjectId={SESSION.projectId}
              keyHint={undefined}
              onNewProject={noAction}
              onApiKey={noAction}
              onSignOut={noAction}
            />
          </div>
          <div className="lp-session-main">
            <div className="lp-session-header" inert aria-hidden="true">
              <WorkspaceHeader
                projectName="Highland stays"
                job={job}
                panelOpen
                onTogglePanel={noAction}
                detailsOpen={false}
                onToggleDetails={noAction}
              />
            </div>
            <div className="lp-session-mobile-tabs">
              <button
                type="button"
                aria-pressed={mobileView === "session"}
                onClick={() => setMobileView("session")}
              >
                Session
              </button>
              <button
                type="button"
                aria-pressed={mobileView === "preview"}
                onClick={() => setMobileView("preview")}
              >
                App preview
              </button>
              <button type="button" aria-label="Replay the build" onClick={replay}>
                <RotateCcw className="size-3.5" />
              </button>
            </div>
            <div className="lp-session-panes">
              <div className="lp-session-chat">
                <div className="lp-session-transcript">
                  <ChatTranscript items={items} />
                </div>
                <div className="lp-session-composer" aria-hidden="true">
                  Ask nap to change something…
                  <span>
                    + <span>↑</span>
                  </span>
                </div>
                <button type="button" className="lp-session-replay" onClick={replay}>
                  <RotateCcw className="size-3" /> Replay the build
                </button>
              </div>
              <div className="lp-session-right">
                <div className="lp-session-preview-tabs">
                  <button
                    type="button"
                    aria-pressed={view === "preview"}
                    onClick={() => setView("preview")}
                  >
                    <Globe className="size-3.5" />
                    Preview
                  </button>
                  <button
                    type="button"
                    aria-pressed={view === "code"}
                    onClick={() => setView("code")}
                  >
                    <Files className="size-3.5" />
                    Code
                  </button>
                  <span>INTERACTIVE DEMO</span>
                </div>
                <div inert aria-hidden="true">
                  <BrowserToolbar
                    route="/"
                    previewUrl={undefined}
                    onRouteChange={noAction}
                    onReload={noAction}
                  />
                </div>
                <div className="lp-session-app">
                  <pre className="lp-booking-code" hidden={view !== "code"}>
                    <code>{`// src/App.tsx · booking demo\n\nconst nightlyRate = 195;\nconst total = nights * nightlyRate;\n\nfunction reserve() {\n  setConfirmed(true);\n}\n\n// Change a date or the length of stay\n// in Preview. The total updates instantly.`}</code>
                  </pre>
                  <div className="lp-session-preview" hidden={view !== "preview"}>
                    {phase === "ready" ? (
                      <BookingPreview key={bookingVersion} />
                    ) : (
                      <div className="lp-session-building">
                        <span className="lp-serif">
                          {phase === "prompt"
                            ? "A little idea, taking shape."
                            : "Building your quiet getaway."}
                        </span>
                        <div className="lp-booking-scaffold">
                          <i />
                          <i />
                          <div>
                            <i />
                            <i />
                            <i />
                          </div>
                        </div>
                        <p>
                          {phase === "prompt"
                            ? "Prompt received"
                            : "Writing the app and running its checks"}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </fieldset>
    </div>
  );
}
