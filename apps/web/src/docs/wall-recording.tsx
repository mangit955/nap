"use client";

/**
 * The recorded session on the docs home, set in the landing page's night-sky panel.
 *
 * It starts as the poster and a button, and becomes the player only when pressed: the home page is
 * a way in, and eight megabytes of video should follow a decision to watch, not arrive with the
 * page. Pressing it plays at once, with the player's own controls from then on.
 */

import { Play } from "lucide-react";
import { useState } from "react";

export function WallRecording({
  src,
  poster,
  label,
  cue,
}: {
  src: string;
  poster: string;
  label: string;
  /** The words on the button, which say what pressing it costs. */
  cue: string;
}) {
  const [playing, setPlaying] = useState(false);

  return (
    <div className="lp-wall docs-wall">
      <div className="docs-wall-window">
        {playing ? (
          // biome-ignore lint/a11y/useMediaCaption: no speech and no audio track — there is nothing to caption.
          <video src={src} poster={poster} controls autoPlay playsInline aria-label={label} />
        ) : (
          <button type="button" onClick={() => setPlaying(true)} aria-label={`Play: ${label}`}>
            {/* biome-ignore lint/performance/noImgElement: a static poster; next/image would resize a frame that is shown at its own size. */}
            <img src={poster} alt="" width={1280} height={720} />
            <span className="docs-wall-cue">
              <Play aria-hidden="true" size={12} fill="currentColor" />
              {cue}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
