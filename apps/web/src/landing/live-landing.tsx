"use client";

/**
 * The front page, wired to the session.
 *
 * One question is asked here and answered for the whole page — whether anybody is signed in —
 * because the hero and the list both need it and two subscriptions would be two answers that
 * can disagree for a frame.
 */

import { useRouter } from "next/navigation";
import { authClient } from "../auth/client.ts";
import { LiveProjectList } from "../projects/live-project-list.tsx";
import { Landing } from "./landing.tsx";
import { LiveHero } from "./live-hero.tsx";

export function LiveLanding() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const signedIn = session != null;

  return (
    <Landing
      auth={isPending ? "pending" : signedIn ? "signed-in" : "signed-out"}
      hero={<LiveHero signedIn={signedIn} />}
      projects={<LiveProjectList />}
      onSignOut={() => {
        void authClient.signOut().then(() => {
          // A refresh rather than a push: the session hook and the project list both hold
          // answers that are now wrong, and re-rendering the route is what discards them.
          router.refresh();
        });
      }}
    />
  );
}
