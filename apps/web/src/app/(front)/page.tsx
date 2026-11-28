import type { Metadata } from "next";
import { LiveLanding } from "../../landing/live-landing.tsx";

const description =
  "Describe an app and get verified code. Num1 builds it on its own cloud computer, runs your checks, tests it like a user, and hands back a pull request.";

// Only the front page carries the new name for now; the app, the docs and the dashboard keep
// theirs until they are redrawn.
export const metadata: Metadata = {
  title: "Num1 — the coding agent with its own computer",
  description,
  openGraph: {
    type: "website",
    siteName: "Num1",
    title: "Num1 — describe an app, get verified code",
    description,
    // A page's `openGraph` replaces the root layout's whole object, so the address is repeated;
    // it resolves against the root's `metadataBase`.
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "Num1 — describe an app, get verified code",
    description,
  },
};

/**
 * The front door. Anybody signed in is sent on to the dashboard (`LiveLanding`); the workspace
 * lives at `/p/<projectId>`, so a project is a URL you can bookmark.
 */
export default function Page() {
  return <LiveLanding />;
}
