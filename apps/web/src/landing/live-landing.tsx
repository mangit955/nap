"use client";

/**
 * The front page, wired to the session.
 *
 * One question is asked here and answered for the whole page — whether anybody is signed in —
 * because the hero and the redirect below both need it and two subscriptions would be two
 * answers that can disagree for a frame.
 *
 * **Somebody signed in does not belong here.** This page is a pitch: it explains what the
 * product is and offers a way in, and neither is any use to a person who has five projects and
 * came back to open one. They go to the dashboard, which is where their work is.
 *
 * **`isPending` guards the header, not the redirect.** A session that has not resolved is not a
 * session, so the redirect cannot fire early on its own; what *can* go wrong early is the bar,
 * which would otherwise put a Sign in link under the cursor of somebody who is signed in and
 * about to be moved. So the page is drawn as `pending` until it knows, and the redirect asks
 * only whether there is somebody there.
 *
 * `replace` rather than `push`: the front page is not somewhere the back button should return a
 * signed-in visitor to, since arriving there would only redirect them again.
 */

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { authClient } from "../auth/client.ts";
import { Hero } from "./hero.tsx";
import { Landing } from "./landing.tsx";

export function LiveLanding() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const signedIn = session != null;

  useEffect(() => {
    if (signedIn) router.replace("/dashboard");
  }, [signedIn, router]);

  return (
    <Landing
      // Never `signed-in`: this page has nothing to show that visitor, and drawing their
      // projects for the frame before the redirect lands is a flash of the wrong page.
      auth={isPending || signedIn ? "pending" : "signed-out"}
      hero={<Hero />}
    />
  );
}
