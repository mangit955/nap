import { LiveDashboard } from "../../dashboard/live-dashboard.tsx";

/**
 * Where somebody signed in lands: their projects, and the box to start another one.
 *
 * The front page stays the way in for visitors who have no account yet, and sends anybody who
 * does have one here — a page cannot be both a pitch and a workbench without doing one of them
 * badly.
 */
export default function Page() {
  return <LiveDashboard />;
}
