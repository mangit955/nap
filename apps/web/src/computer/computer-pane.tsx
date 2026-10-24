"use client";

import type { ComputerStream } from "@nap/shared/computer-access";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { ArrowLeft, ArrowRight, ExternalLink, Maximize2 } from "lucide-react";
import { type CSSProperties, type RefObject, useCallback, useId, useRef, useState } from "react";
import type { FetchJson } from "../files/use-project-files.ts";
import { LitBox } from "../glow/lit-box.tsx";
import { RimGlow } from "../glow/rim-glow.tsx";
import { useAiPulse } from "../glow/use-pulse.ts";
import { useRimMask } from "../glow/use-rim-mask.ts";
import { useElapsed } from "../ui/use-elapsed.ts";
import { ComputerInputSurface } from "./computer-input-surface.tsx";
import {
  type DesktopConnectionStatus,
  LiveDesktopFrame,
  type RfbFactory,
} from "./live-desktop-frame.tsx";
import { useComputerControl } from "./use-computer-control.ts";
import { useDesktopStream } from "./use-desktop-stream.ts";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
export function computerScreenshotUrl(sessionId: string, seq: number): string {
  return `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/computer/screenshots/${seq}`;
}

export function ComputerPane({
  events,
  selectedSeq,
  onSeek,
  sessionId,
  sandboxId,
  projectId,
  active = true,
  busy = false,
  eventStreamReady = true,
  fetchJson,
  createRfb,
}: {
  events: readonly StoredEvent[];
  selectedSeq: number | null;
  onSeek: (seq: number | null) => void;
  sessionId?: string | undefined;
  sandboxId?: string | undefined;
  projectId?: string | undefined;
  active?: boolean;
  busy?: boolean;
  eventStreamReady?: boolean;
  fetchJson?: FetchJson | undefined;
  createRfb?: RfbFactory | Promise<RfbFactory>;
}) {
  const root = useRef<HTMLElement>(null);
  const reasonId = useId();
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
  const [quality, setQuality] = useState<"auto" | "sharp" | "data-saver">("auto");
  const liveWanted = active && selectedSeq === null && !!sessionId && !!sandboxId;
  const stream = useDesktopStream({ sessionId, sandboxId, active: liveWanted, fetchJson });
  const liveFrame = stream.state.status === "ready";
  const [connection, setConnection] = useState<{
    credentials: ComputerStream;
    status: DesktopConnectionStatus;
  } | null>(null);
  const connected =
    stream.state.status === "ready" &&
    connection?.credentials === stream.state.credentials &&
    connection.status === "connected";
  const control = useComputerControl({
    sessionId: sessionId ?? null,
    active: liveWanted && eventStreamReady,
    connected,
    busy,
    sourceKey: stream.generation ?? "inactive",
    ...(fetchJson ? { fetch: fetchJson } : {}),
  });
  const source =
    frame && !liveWanted
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
  const screenshotMessage = starting
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
  const message = liveWanted
    ? stream.state.status === "error"
      ? "Failed to connect to Nap's computer"
      : liveFrame
        ? null
        : "Connecting to Nap's computer…"
    : screenshotMessage;
  const progress: CSSProperties & { "--computer-progress": string } = {
    "--computer-progress": `${max ? (cursor / max) * 100 : 0}%`,
  };
  const retry = () => {
    if (liveWanted) {
      stream.retry();
      return;
    }
    setAttempt((value) => value + 1);
    setFailed(null);
  };
  return (
    <section ref={root} className="computer-pane" aria-label="Computer">
      <div className="computer-stage">
        <div
          ref={frameRef}
          className={`computer-frame${control.driving ? " ai-lights" : ""}`}
          data-driving={control.driving || undefined}
        >
          {control.driving && <DrivingGlow frameRef={frameRef} />}
          {stream.state.status === "ready" && (
            <LiveDesktopFrame
              credentials={stream.state.credentials}
              quality={quality}
              {...(createRfb ? { createRfb } : {})}
              onRetry={stream.retry}
              onConnectionChange={(status) => {
                if (stream.state.status === "ready")
                  setConnection({ credentials: stream.state.credentials, status });
              }}
            >
              <div className="computer-input-overlay">
                <ComputerInputSurface
                  driving={control.driving}
                  available={control.available}
                  sourceKey={stream.generation ?? "inactive"}
                  sendActions={control.sendActions}
                  takeControl={control.takeControl}
                  release={control.release}
                />
              </div>
            </LiveDesktopFrame>
          )}
          {!liveFrame && (
            <div className="computer-still" role="application" aria-label="Remote computer">
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
                  {(liveWanted && stream.state.status !== "error") ||
                  (source && loaded !== source && failed !== source) ? (
                    <LitBox paletteRef={frameRef} faceClassName="computer-state-card">
                      <p>{message}</p>
                    </LitBox>
                  ) : (
                    <div className="computer-state-card">
                      <p>{message}</p>
                      {((liveWanted && stream.state.status === "error") ||
                        (failed === source && source)) && (
                        <button type="button" onClick={retry}>
                          Retry
                        </button>
                      )}
                    </div>
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
            title="Follow the live desktop"
          >
            {selectedSeq === null && <span className="computer-live-dot" aria-hidden="true" />}
            {selectedSeq === null ? "Live" : "Go to live desktop"}
          </button>
          {control.driving ? (
            <button type="button" onClick={control.release}>
              Release control
            </button>
          ) : (
            <button
              type="button"
              disabled={!control.available}
              aria-describedby={reasonId}
              onClick={() => void control.takeControl()}
            >
              Take control of Nap's computer
            </button>
          )}
          <select
            aria-label="Stream quality"
            disabled={!liveFrame}
            value={quality}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === "auto" || value === "sharp" || value === "data-saver")
                setQuality(value);
            }}
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
            disabled={!frame && !(liveWanted && projectId)}
            onClick={() => {
              const url =
                liveWanted && projectId
                  ? `/p/${encodeURIComponent(projectId)}?panel=computer`
                  : frame
                    ? computerScreenshotUrl(frame.sessionId, frame.seq)
                    : null;
              if (url) window.open(url, "_blank", "noopener,noreferrer");
            }}
          >
            <ExternalLink aria-hidden="true" />
          </button>
        </div>
        <p id={reasonId} className="computer-control-reason" aria-live="polite">
          {control.driving ? control.status : control.disabledReason}
        </p>
        {control.error && control.error !== control.disabledReason && (
          <p className="computer-control-reason" role="alert">
            {control.error}
          </p>
        )}
        <p className="computer-caption">
          {liveWanted
            ? "Live desktop"
            : frame
              ? `Screenshot · ${new Date(frame.createdAt).toISOString().slice(11, 19)} UTC`
              : "Screenshot history"}
        </p>
        {fullscreenError && <p role="alert">Full screen is unavailable in this browser.</p>}
      </div>
    </section>
  );
}

function DrivingGlow({ frameRef }: { frameRef: RefObject<HTMLDivElement | null> }) {
  const layers = useRimMask(frameRef, 0);
  useAiPulse({ ref: frameRef, paletteRef: frameRef, pulseMs: 1600, gapMs: 3400 });
  return <RimGlow layers={layers} />;
}
