"use client";

/**
 * The ghost, awake and keeping itself busy, for the minute a project takes to come up.
 *
 * **Awake rather than asleep**, which is the opposite of the mark's resting state and is the
 * point: a sleeping ghost over "starting the dev server" says nothing is happening. This one
 * has its eyes open, has stopped yawning z's, and does something every couple of seconds — the
 * evidence that the page is alive during a wait where nothing else on screen moves.
 *
 * **Which thing it does is chosen, not sequenced.** A fixed loop is a spinner with extra frames;
 * the eye learns it in two cycles and stops seeing it. `nextTrick` picks a different one each
 * time, weighted so the quiet gestures are common and the daft one is rare.
 *
 * The trick is a `data-` attribute on a wrapper rather than a prop on the mark: `NapMark` is a
 * tab icon and a header logo as well as this, and it stays a drawing with no idea it is being
 * used as a loading state. The stylesheet does the rest, which is also what keeps reduced
 * motion working through the cascade rather than through a second copy of the rules here.
 *
 * `aria-hidden`, because the sentence beside it already says what is happening; a reader gets
 * "Starting the dev server…" and not a description of a hopping ghost.
 */

import { useEffect, useState } from "react";
import { NapMark } from "./nap-mark.tsx";
import { nextTrick, REST_MS, type Trick } from "./nap-tricks.ts";

export function NapLoader({ className = "size-12" }: { className?: string }) {
  const [trick, setTrick] = useState<Trick | undefined>(undefined);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    // Perform, then rest, then choose again — one chain of timeouts rather than an interval,
    // because each trick sets its own length and an interval would cut the long ones short.
    const schedule = (previous: Trick | undefined, delay: number) => {
      timer = setTimeout(() => {
        const chosen = nextTrick(previous, Math.random());
        setTrick(chosen);
        // `undefined` between tricks is the still beat: no `data-trick`, no animation, a ghost
        // simply standing there. Without it nothing ever stops moving, which reads as manic.
        timer = setTimeout(() => {
          setTrick(undefined);
          schedule(chosen, REST_MS);
        }, chosen.ms);
      }, delay);
    };

    // A short beat before the first one: a ghost already mid-hop as the pane appears reads as a
    // page that jumped rather than as something starting up.
    schedule(undefined, REST_MS);

    return () => clearTimeout(timer);
  }, []);

  return (
    <span
      aria-hidden="true"
      className={`nap-loader ${className}`}
      {...(trick === undefined ? {} : { "data-trick": trick.name })}
    >
      <NapMark className="size-full" />
    </span>
  );
}
