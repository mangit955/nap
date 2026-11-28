"use client";

import { FEATURED_REPLAY_PATH } from "../replay/featured.ts";
import { SessionStage } from "./showcase/session-stage.tsx";
import { useReveal } from "./use-reveal.ts";

/**
 * The band under the hero: the agent's session, mid-task, on a ruled stage.
 *
 * The stage's `data-reveal` is what plays the session's motion (`num1.css`): `pending` holds the
 * terminal lines and the cursor back, `in` plays them once, and no attribute at all (no script,
 * reduced motion) is the finished frame.
 */
export function LiveStage() {
  const { ref, state } = useReveal<HTMLElement>();
  return (
    <section
      ref={ref}
      id="live"
      aria-label="Num1 at work"
      className="n1-stage"
      data-reveal={state === "idle" ? undefined : state}
    >
      <div className="n1-wrap">
        <div className="n1-stage-h">
          <span className="n1-label">
            <b>[ live ]</b>&nbsp; num1 is testing the import
          </span>
          <a href={FEATURED_REPLAY_PATH} className="n1-label n1-stage-replay">
            Watch the replay <span aria-hidden="true">→</span>
          </a>
        </div>
        <SessionStage />
      </div>
    </section>
  );
}
