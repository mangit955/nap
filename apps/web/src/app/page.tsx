import { LiveLanding } from "../landing/live-landing.tsx";

/**
 * The front door: a box to describe an app in, and — if you are signed in — everything you have
 * already made. The workspace lives at `/p/<projectId>`, so a project is a URL you can bookmark
 * rather than whatever this browser happened to open last.
 */
export default function Page() {
  return <LiveLanding />;
}
