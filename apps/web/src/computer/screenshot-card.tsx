"use client";

import type { NapEventOf } from "@nap/shared/events";
import { use } from "react";
import { computerScreenshotUrl } from "./computer-pane.tsx";
import { ComputerNavigation } from "./navigation.tsx";

export function ScreenshotCard({ frame }: { frame: NapEventOf<"computer.screenshot"> }) {
  const seek = use(ComputerNavigation);
  return (
    <button
      type="button"
      aria-label="Open computer screenshot"
      className="computer-screenshot-card"
      disabled={!seek}
      onClick={() => seek?.(frame.seq)}
    >
      {/* The API requires the owner's cookie; Next's image optimizer does not send it. */}
      {/* biome-ignore lint/performance/noImgElement: authenticated screenshots must load in the owner's browser. */}
      <img
        src={computerScreenshotUrl(frame.sessionId, frame.seq)}
        crossOrigin="use-credentials"
        alt="Computer screenshot"
        width={frame.payload.width}
        height={frame.payload.height}
        loading="lazy"
      />
      <span>Computer screenshot available</span>
    </button>
  );
}
