import { LiveWorkspace } from "../../../workspace/live-workspace.tsx";

/**
 * The workspace at a static address, so the dashboard can prefetch it and enter it without a
 * request. The workspace learns its project from `workspace/workspace-entry.ts` and then shows
 * the project's own address; `/p/[projectId]` renders the same component for that address on a
 * reload or a shared link.
 */
export default function Page() {
  return <LiveWorkspace />;
}
