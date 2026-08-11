import { AppShell } from "../../../components/app-shell.tsx";

/**
 * One project's workspace.
 *
 * `params` is a promise in this version of Next and has to be awaited — see
 * `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`. The id is
 * handed to the shell as a prop; which session inside the project the panes talk to is
 * resolved from the server, not from the URL.
 */
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  return <AppShell projectId={projectId} />;
}
