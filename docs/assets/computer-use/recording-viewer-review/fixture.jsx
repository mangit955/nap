import { useState } from "react";
import { createRoot } from "react-dom/client";
import { RecordingViewer } from "../../../../apps/web/src/computer/recording-viewer.tsx";
import "./fixture.css";

const sample = {
  title: "Save and delete a note",
  videoUrl: "/fixture.webm",
  counts: { passed: 1, failed: 1, untested: 1 },
  annotations: [
    { timeMs: 0, annotation: { type: "setup", description: "Open the notes app" } },
    { timeMs: 2000, annotation: { type: "test_start", id: "save", description: "Save a note" } },
    {
      timeMs: 2100,
      annotation: {
        type: "assertion",
        id: "save",
        expectation: "The saved note appears in the list",
        result: "untested",
      },
    },
    {
      timeMs: 4200,
      annotation: {
        type: "assertion",
        id: "save",
        expectation: "The saved note appears in the list",
        result: "passed",
      },
    },
    {
      timeMs: 5000,
      annotation: { type: "test_start", id: "delete", description: "Delete a note" },
    },
    {
      timeMs: 6100,
      annotation: {
        type: "assertion",
        id: "delete",
        expectation: "The deleted note disappears from the list",
        result: "failed",
      },
    },
    {
      timeMs: 7000,
      annotation: {
        type: "assertion",
        id: "undo",
        expectation: "Undo restores the note",
        result: "untested",
      },
    },
  ],
};
const regressionSample = {
  ...sample,
  counts: { passed: 4, failed: 0, untested: 0 },
  annotations: [
    { id: "zero", description: "Starts with Setup", timeMs: 0 },
    { id: "shared-first", description: "Shared first", timeMs: 1001 },
    { id: "shared-second", description: "Shared second", timeMs: 1001 },
    { id: "later", description: "Later chapter", timeMs: 5000 },
  ].flatMap(({ id, description, timeMs }) => [
    { timeMs, annotation: { type: "test_start", id, description } },
    {
      timeMs,
      annotation: {
        type: "assertion",
        id,
        expectation: `${description} expectation`,
        result: "passed",
      },
    },
  ]),
};
const selectedSample =
  new URLSearchParams(location.search).get("chapters") === "regressions"
    ? regressionSample
    : sample;
function Fixture() {
  const [viewer, setViewer] = useState("recording");
  return (
    <main>
      <aside>
        Nap <small>Local UI review</small>
      </aside>
      <article>
        <h1>Notes workspace</h1>
        <p>Fixture video and annotation data. No model, desktop or API connection.</p>
        <button type="button" onClick={() => setViewer("recording")}>
          Watch recording
        </button>
        <button type="button" onClick={() => setViewer("empty")}>
          View empty state
        </button>
        <button type="button" onClick={() => setViewer("error")}>
          View unavailable recording
        </button>
      </article>
      {viewer !== "closed" && (
        <RecordingViewer
          recording={
            viewer === "empty"
              ? null
              : viewer === "error"
                ? { ...selectedSample, videoUrl: "/missing.webm" }
                : selectedSample
          }
          onClose={() => setViewer("closed")}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
