import { LiveSignIn } from "../../auth/live-sign-in.tsx";

/**
 * The way in.
 *
 * Nothing redirects here yet: signing in works and creates a real session, but no route
 * refuses a request without one. Authorization lands across every route at once rather than
 * a little at a time, so that the test proving it can be a table with no gaps in it.
 */
export default function Page() {
  return <LiveSignIn />;
}
