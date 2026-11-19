import { LiveWorkspace } from "../../../workspace/live-workspace.tsx";

/**
 * One project's workspace.
 *
 * The route's `params` are deliberately not read: the sidebar switches projects with
 * `history.pushState`, which changes the address without rendering this page again, so its
 * params would go on naming the project the tab first opened. The workspace reads the project
 * from the pathname instead — see `workspace/open-project.ts`. Which session inside the project
 * the panes talk to is resolved from the server, not from the URL.
 */
export default function Page() {
  return <LiveWorkspace />;
}
