import type { FileListing } from "@nap/shared/files-protocol";
import type { ModelChoice } from "@nap/shared/models-protocol";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import type { ProjectSummaryPayload } from "@nap/shared/projects-protocol";
import type { FetchJson } from "../files/use-project-files.ts";
import { STORY_THREAD_IDS, type StoryThreadId } from "./story-demo-protocol.ts";

export const STORY_PROMPT =
  "Build a personal finance dashboard with spending trends, recent transactions, and a clear view of my balance.";
export type StoryThread = {
  id: StoryThreadId;
  project: ProjectSummaryPayload & { sessionIds: [string, ...string[]] };
  prompt: string;
  introduction: string;
  finished: string;
  previewPath: string;
  files: Record<string, string>;
};
export const STORY_DEFAULT_MODEL = "openai/gpt-5.6-luna";
export const STORY_MODELS = [
  { id: STORY_DEFAULT_MODEL, label: "GPT-5.6 Luna", free: false, available: true },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    label: "Nemotron 3 Ultra",
    free: true,
    available: true,
  },
] satisfies ModelChoice[];
export const STORY_FILES: Record<string, string> = {
  "src/App.tsx": `import { useState } from "react";\nimport { SpendingChart } from "./SpendingChart";\n\nexport default function App() {\n  const [period, setPeriod] = useState("month");\n  return (\n    <main className="dashboard">\n      <h1>Room to do more.</h1>\n      <Balance amount={12684.50} />\n      <PeriodSwitch value={period} onChange={setPeriod} />\n      <SpendingChart period={period} />\n      <Transactions />\n    </main>\n  );\n}\n`,
  "src/index.css": `:root { color-scheme: dark; }\nbody { margin: 0; background: #111512; color: #d4d9cd; }\n.dashboard { max-width: 1100px; margin: auto; padding: 32px; }\n`,
  "package.json": JSON.stringify(
    {
      name: "ledger",
      scripts: {
        dev: "vite --host 0.0.0.0",
        build: "tsc -b && vite build",
        typecheck: "tsc --noEmit",
      },
      dependencies: { react: "19.2.8", "react-dom": "19.2.8" },
    },
    null,
    2,
  ),
};
const THREADS: Record<StoryThreadId, StoryThread> = {
  finance: {
    id: "finance",
    project: {
      projectId: "bb42b020-3c6d-411d-bff5-dc1b72b4c763",
      name: "Personal finance",
      status: "ready",
      sandboxId: "landing-finance",
      updatedAt: "2026-10-25T12:00:00.000Z",
      sessionIds: ["e8c65b54-35a0-4dcb-aa99-911d48a97c85"],
    },
    prompt: STORY_PROMPT,
    introduction:
      "I'll build the dashboard with a balance overview, spending trends, and recent transactions. Then I'll run the project's checks.",
    finished:
      "The dashboard is ready in the preview. Try Month and Year to explore the data. Typecheck and production build passed, and your checkpoint is saved.",
    previewPath: "/demo/ledger",
    files: STORY_FILES,
  },
  cabins: {
    id: "cabins",
    project: {
      projectId: "9a81f390-b50b-41d5-a989-77d1a3fb804c",
      name: "Highland stays",
      status: "ready",
      sandboxId: "landing-cabins",
      updatedAt: "2026-10-25T11:00:00.000Z",
      sessionIds: ["119e4b11-6760-4f79-9da3-a81543cf2bf3"],
    },
    prompt:
      "Build a cabin booking app for a quiet weekend in the Highlands. Let me choose a date, change the length of stay, and reserve the cabin.",
    introduction:
      "I'll build the cabin page with arrival dates, a length-of-stay picker, live pricing, and a reservation confirmation.",
    finished:
      "The booking flow is ready. Pick an arrival date and length of stay, then try reserving the cabin in the preview. Typecheck and production build passed.",
    previewPath: "/demo/booking",
    files: {
      ...STORY_FILES,
      "src/App.tsx":
        'import { useState } from "react";\n\nexport default function App() {\n  const [nights, setNights] = useState(2);\n  const [confirmed, setConfirmed] = useState(false);\n  return <main>\n    <h1>The Heather Cabin</h1>\n    <p>{nights * 195} USD total</p>\n    <button onClick={() => setNights(nights + 1)}>Stay longer</button>\n    <button onClick={() => setConfirmed(true)}>Reserve your quiet</button>\n    {confirmed && <p>Your stay is confirmed.</p>}\n  </main>;\n}\n',
      "src/index.css": "body { background: #f3f0e9; color: #263c31; }\n",
    },
  },
  launch: {
    id: "launch",
    project: {
      projectId: "4b840bd0-963f-4cb4-8bb0-af6aef257670",
      name: "Launch tracker",
      status: "ready",
      sandboxId: "landing-launch",
      updatedAt: "2026-10-25T10:00:00.000Z",
      sessionIds: ["378e4f9c-c069-4eda-bae0-a6bd939e212c"],
    },
    prompt:
      "Build a launch tracker for a small team. Show task owners and the launch date, and let me mark tasks complete.",
    introduction:
      "I'll build a launch checklist with task owners and a completion count that updates as you finish tasks.",
    finished:
      "The launch tracker is ready. Complete a task in the preview and watch the progress update. Typecheck and production build passed.",
    previewPath: "/demo/launch",
    files: {
      ...STORY_FILES,
      "src/App.tsx":
        'import { useState } from "react";\n\nexport default function App() {\n  const [done, setDone] = useState(false);\n  return <main>\n    <h1>A little closer to launch.</h1>\n    <button onClick={() => setDone(!done)}>\n      {done ? "Launch checklist complete" : "Complete launch checklist"}\n    </button>\n  </main>;\n}\n',
      "src/index.css": "body { background: #f2f3f5; color: #242933; }\n",
    },
  },
};
export const storyThread = (id: StoryThreadId): StoryThread => THREADS[id];
export const storyListing = (thread: StoryThread): FileListing => ({
  ready: true,
  files: Object.keys(thread.files),
  truncated: false,
});
export const fetchStoryFile: FetchJson = async (url) => {
  const request = new URL(url, "http://localhost");
  const thread = STORY_THREAD_IDS.map(storyThread).find((item) =>
    request.pathname.includes(`/sessions/${item.project.sessionIds[0]}/`),
  );
  const path = request.searchParams.get("path");
  const contents = path === null ? undefined : thread?.files[path];
  return path === null || contents === undefined
    ? Response.json({ error: "Example file not found" }, { status: 404 })
    : Response.json({
        path,
        contents,
        bytes: new TextEncoder().encode(contents).length,
        truncated: false,
      });
};
export function storyEvents(
  thread: StoryThread,
  prompt: string,
  at: string,
  ready: boolean,
): StoredEvent[] {
  const base = {
    sessionId: thread.project.sessionIds[0],
    turnId: "8d13fefe-d0e9-43a8-b555-168b5867d9d9",
    createdAt: at,
  };
  const events: StoredEvent[] = [
    { ...base, seq: 1, type: "user.message", payload: { text: prompt } },
    { ...base, seq: 2, type: "turn.started", payload: { source: "user" } },
    {
      ...base,
      seq: 3,
      type: "agent.message",
      payload: {
        text: thread.introduction,
      },
    },
    {
      ...base,
      seq: 4,
      type: "file.changed",
      payload: {
        path: "src/App.tsx",
        changeType: "created",
        diff: "+export default function App() {\n+  return <Dashboard />;\n+}",
      },
    },
    {
      ...base,
      seq: 5,
      type: "file.changed",
      payload: {
        path: "src/index.css",
        changeType: "created",
        diff: `+${thread.files["src/index.css"] ?? ""}`,
      },
    },
    {
      ...base,
      seq: 6,
      type: "tool.call",
      payload: {
        toolCallId: "example-check",
        toolName: "run_command",
        input: { command: "npm run typecheck && npm run build" },
      },
    },
  ];
  if (ready)
    events.push(
      {
        ...base,
        seq: 7,
        type: "tool.result",
        payload: {
          toolCallId: "example-check",
          toolName: "run_command",
          ok: true,
          output: "Typecheck passed. Production build completed.",
        },
      },
      {
        ...base,
        seq: 8,
        type: "agent.message",
        payload: {
          text: thread.finished,
        },
      },
      {
        ...base,
        seq: 9,
        type: "turn.completed",
        payload: {
          durationMs: 2800,
          usage: { inputTokens: 0, outputTokens: 0 },
          commitSha: "3f9c2a1",
        },
      },
    );
  return events;
}
