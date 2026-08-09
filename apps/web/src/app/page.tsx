import { LiveProjectList } from "../projects/live-project-list.tsx";

/**
 * The front door: everything you have made. The workspace lives at `/p/<projectId>`, so a
 * project is a URL you can bookmark rather than whatever this browser happened to open last.
 */
export default function Page() {
  return <LiveProjectList />;
}
