"use client";

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { ArrowLeft, ArrowRight, ExternalLink, Maximize2 } from "lucide-react";
import { type CSSProperties, useCallback, useRef, useState } from "react";
import { LitBox } from "../glow/lit-box.tsx";
import { useAiPulse } from "../glow/use-pulse.ts";
import { useElapsed } from "../ui/use-elapsed.ts";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
export function computerScreenshotUrl(sessionId: string, seq: number): string {
  return `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/computer/screenshots/${seq}`;
}

export function ComputerPane({
  events,
  selectedSeq,
  onSeek,
}: {
  events: readonly StoredEvent[];
  selectedSeq: number | null;
  onSeek: (seq: number | null) => void;
}) {
  const root = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLButtonElement>(null);
  useAiPulse({ ref: liveRef, paletteRef: liveRef, pulseMs: 1600, gapMs: 3400 });
  const frames = events.filter((event) => event.type === "computer.screenshot");
  const max = events.at(-1)?.seq ?? 0;
  const cursor = selectedSeq ?? max;
  const frame = frames.findLast((event) => event.seq <= cursor);
  const previous = frames.findLast((event) => event.seq < cursor);
  const next = frames.find((event) => event.seq > cursor);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [fullscreenError, setFullscreenError] = useState(false);
  const source = frame
    ? `${computerScreenshotUrl(frame.sessionId, frame.seq)}?attempt=${attempt}`
    : null;
  const imageRef = useCallback(
    (image: HTMLImageElement | null) => {
      if (!image?.complete) return;
      if (image.naturalWidth > 0) setLoaded(source);
      else setFailed(source);
    },
    [source],
  );
  const status = events.findLast((event) => event.type === "computer.status");
  const starting =
    selectedSeq === null &&
    status?.type === "computer.status" &&
    status.payload.state === "starting";
  const elapsed = useElapsed({ startedAt: status?.createdAt, precision: 0 });
  const message = starting
    ? `Waiting for desktop to be ready (${elapsed})`
    : !frame
      ? selectedSeq === null
        ? "Waiting for Nap's computer…"
        : "No screenshot is available at this point in history."
      : failed === source
        ? "Failed to connect to Nap's computer"
        : loaded !== source
          ? "Connecting to Nap's computer…"
          : null;
  const progress: CSSProperties & { "--computer-progress": string } = {
    "--computer-progress": `${max ? (cursor / max) * 100 : 0}%`,
  };
  const retry = () => {
    setAttempt((value) => value + 1);
    setFailed(null);
  };
  return (
    <section ref={root} className="computer-pane" aria-label="Computer">
      <div className="computer-stage">
        <div
          ref={frameRef}
          className="computer-frame"
          role="application"
          aria-label="Remote computer"
        >
          {source && (
            // biome-ignore lint/performance/noImgElement: The image optimizer has no owner session cookie.
            <img
              key={source}
              ref={imageRef}
              src={source}
              crossOrigin="use-credentials"
              alt="Computer screenshot"
              draggable={false}
              onLoad={() => setLoaded(source)}
              onError={() => setFailed(source)}
            />
          )}
          {message && (
            <div className="computer-state" role="status">
              {source && loaded !== source && failed !== source ? (
                <LitBox paletteRef={frameRef} faceClassName="computer-state-card">
                  <p>{message}</p>
                </LitBox>
              ) : (
                <div className="computer-state-card">
                  <p>{message}</p>
                  {failed === source && source && (
                    <button type="button" onClick={retry}>
                      Retry
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="computer-controls">
        <input
          type="range"
          min={0}
          max={max}
          value={Math.min(cursor, max)}
          aria-label="Session timeline"
          disabled={frames.length === 0}
          onChange={(event) => onSeek(Number(event.currentTarget.value))}
          style={progress}
        />
        <div className="computer-control-row">
          <button
            type="button"
            aria-label="Previous event"
            disabled={!previous}
            onClick={() => previous && onSeek(previous.seq)}
          >
            <ArrowLeft aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Next event"
            disabled={!next}
            onClick={() => next && onSeek(next.seq)}
          >
            <ArrowRight aria-hidden="true" />
          </button>
          <button
            ref={liveRef}
            type="button"
            className="computer-live"
            onClick={() => onSeek(null)}
            title="Follow new screenshots"
          >
            {selectedSeq === null && <span className="computer-live-dot" aria-hidden="true" />}
            {selectedSeq === null ? "Live" : "Go to live desktop"}
          </button>
          <select
            aria-label="Stream quality"
            title="Available with live desktop streaming"
            disabled
            defaultValue="auto"
          >
            <option value="auto">Auto</option>
            <option value="sharp">Sharp</option>
            <option value="data-saver">Data saver</option>
          </select>
          <button
            type="button"
            aria-label="Full screen"
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else if (root.current?.requestFullscreen)
                void root.current.requestFullscreen().catch(() => setFullscreenError(true));
              else setFullscreenError(true);
            }}
          >
            <Maximize2 aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Open computer in new window"
            disabled={!frame}
            onClick={() =>
              frame &&
              window.open(
                computerScreenshotUrl(frame.sessionId, frame.seq),
                "_blank",
                "noopener,noreferrer",
              )
            }
          >
            <ExternalLink aria-hidden="true" />
          </button>
        </div>
        <p className="computer-caption">
          {frame
            ? `Screenshot · ${new Date(frame.createdAt).toISOString().slice(11, 19)} UTC`
            : "Screenshot history"}
        </p>
        {fullscreenError && <p role="alert">Full screen is unavailable in this browser.</p>}
      </div>
    </section>
  );
}
