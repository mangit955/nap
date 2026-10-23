"use client";

import type { GitComparison } from "@nap/shared/git-protocol";
import type { ProjectGitHub, PullRequestInspection } from "@nap/shared/github-protocol";
import { AppShell } from "../components/app-shell.tsx";
import { ev, PROJECT_ID, SESSION_ID } from "./events.ts";
import { FakeSocket } from "./fake-socket.ts";

const patch =
  'diff --git a/src/workspace.tsx b/src/workspace.tsx\n--- a/src/workspace.tsx\n+++ b/src/workspace.tsx\n@@ -1,5 +1,9 @@\n import { useState } from "react";\n \n export function Workspace() {\n-  return <Preview />;\n+  const [activeTab, setActiveTab] = useState("browser");\n+  return (\n+    <RightPanel activeTab={activeTab}\n+      onSelect={setActiveTab} />\n+  );\n }\n';
const file: GitComparison["files"][number] = {
  path: "src/workspace.tsx",
  previousPath: null,
  status: "modified",
  additions: 5,
  deletions: 1,
  binary: false,
  truncated: false,
  patch,
};
const comparison: GitComparison = {
  ready: true,
  scope: "branch",
  base: "a9c430e",
  head: "6b84c21",
  baseLabel: "main",
  branch: "feat/right-panel",
  revision: "fixture",
  capturedAt: new Date().toISOString(),
  truncated: false,
  files: [
    file,
    {
      ...file,
      path: "src/styles.css",
      additions: 3,
      deletions: 0,
      patch:
        "@@ -1,1 +1,4 @@\n .panel {\n+  background: #0a0a0a;\n+  min-width: 360px;\n+  border-left: 1px solid #191919;\n",
    },
  ],
};
const github: ProjectGitHub = {
  repository: {
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    userId: "00000000-0000-4000-8000-000000000001",
    installationId: 1,
    repository: { id: 1, fullName: "nap/workspace", defaultBranch: "main", private: false },
    baseBranch: "main",
    environment: { setupCommand: "bun install", devCommand: "bun dev", previewPort: 5173 },
    autoPublish: false,
  },
  jobs: [
    {
      jobId: "00000000-0000-4000-8000-000000000002",
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      baseBranch: "main",
      headBranch: "feat/right-panel",
      baseSha: "a9c430e",
      headSha: "6b84c21",
      pushedSha: "6b84c21",
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/nap/workspace/pull/42",
      pullRequestState: "open",
      publishState: "published",
      checkState: "passed",
      reviewState: "commented",
      error: null,
      updatedAt: new Date().toISOString(),
    },
  ],
  feedback: [],
  followUpPolicy: "owner_approval",
};
const inspection: PullRequestInspection = {
  number: 42,
  title: "Add the workspace right panel",
  body: "A persistent workspace beside chat.\n\n- Keep the browser running across tab changes\n- Inspect files and repository changes\n- Read pull requests without leaving the conversation",
  url: "https://github.com/nap/workspace/pull/42",
  state: "open",
  draft: false,
  author: "manas",
  base: { ref: "main", sha: "a9c430e" },
  head: { ref: "feat/right-panel", sha: "6b84c21" },
  capturedAt: new Date().toISOString(),
  checks: [
    { name: "Typecheck", status: "completed", conclusion: "success" },
    { name: "Tests", status: "completed", conclusion: "success" },
  ],
  timeline: [
    {
      id: "review:1",
      kind: "review",
      author: "reviewer",
      body: "Can the selected tab survive a page refresh?",
      state: "COMMENTED",
      at: new Date().toISOString(),
    },
  ],
  comments: [
    {
      id: 1,
      author: "reviewer",
      body: "Persist the selected tab for this session.",
      path: "src/workspace.tsx",
      line: 4,
      originalLine: 4,
      side: "RIGHT",
      commitId: "6b84c21",
      outdated: false,
      url: "https://github.com/nap/workspace/pull/42#discussion_r1",
    },
  ],
  files: comparison.files,
};
const fetchJson = async (url: string) => {
  const path = new URL(url).pathname;
  if (path.includes("/pull-requests/")) return Response.json(inspection);
  if (path.endsWith("/github")) return Response.json(github);
  if (path.endsWith("/changes")) return Response.json(comparison);
  if (path.endsWith("/files"))
    return Response.json({
      ready: true,
      truncated: false,
      files: ["src/workspace.tsx", "src/styles.css", "package.json", "README.md"],
    });
  if (path.endsWith("/file"))
    return Response.json({
      path: new URL(url).searchParams.get("path"),
      contents:
        'import { useState } from "react";\n\nexport function Workspace() {\n  const [activeTab, setActiveTab] = useState("browser");\n  return <RightPanel activeTab={activeTab} onSelect={setActiveTab} />;\n}\n',
      bytes: 200,
      truncated: false,
    });
  if (path.endsWith("/models"))
    return Response.json({
      models: [{ id: "fixture/free", label: "Scripted model", free: true, available: true }],
      fallback: "fixture/free",
      key: { configured: false },
    });
  if (path.endsWith(`/projects/${PROJECT_ID}`))
    return Response.json({
      projectId: PROJECT_ID,
      name: "Workspace right panel",
      status: "ready",
      sandboxId: "fixture",
      updatedAt: new Date().toISOString(),
      sessionIds: [SESSION_ID],
    });
  return Response.json({ error: "Fixture endpoint unavailable" }, { status: 404 });
};
const createSocket = (url: string) => {
  const socket = new FakeSocket(url);
  setTimeout(() => {
    if (socket.closed) return;
    socket.open();
    socket.deliver({
      type: "event",
      event: ev("preview.ready", { url: "http://localhost:3000/panel-check-app", port: 5173 }, 1),
    });
    socket.deliver({
      type: "event",
      event: ev("user.message", { text: "Make the right sidebar match T3 Code exactly." }, 2),
    });
    socket.deliver({
      type: "event",
      event: ev(
        "agent.message",
        {
          text: "The workspace now keeps your browser, files, diffs, and pull requests beside the conversation.\n\nThe panel uses T3's neutral dark palette and compact tabs. You can resize it, reorder tabs, or maximize the selected view.\n\nOpen `src/workspace.tsx` to inspect the implementation.",
        },
        3,
      ),
    });
    socket.deliver({
      type: "event",
      event: ev(
        "turn.completed",
        {
          usage: { inputTokens: 1000, outputTokens: 300 },
          durationMs: 18000,
          commitSha: "6b84c21",
        },
        4,
      ),
    });
    socket.deliver({ type: "ready" });
  }, 20);
  return socket;
};
/** Local verification fixture. Mounted only by a temporary route. */
export function RightPanelPreview() {
  return <AppShell projectId={PROJECT_ID} fetchJson={fetchJson} createSocket={createSocket} />;
}
