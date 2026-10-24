"use client";

import type { SandboxDesktop } from "@nap/shared/ports/sandbox-desktop";
import type RFB from "@novnc/novnc/lib/rfb";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { LitBox } from "../glow/lit-box.tsx";
import styles from "./live-desktop-frame.module.css";

export type DesktopStreamCredentials = Extract<
  Awaited<ReturnType<SandboxDesktop["streamCredentials"]>>,
  { ok: true }
>["value"];

export type RfbConnection = Pick<
  RFB,
  | "viewOnly"
  | "resizeSession"
  | "scaleViewport"
  | "focusOnClick"
  | "background"
  | "qualityLevel"
  | "compressionLevel"
  | "addEventListener"
  | "removeEventListener"
  | "disconnect"
>;

export type RfbFactory = (...args: ConstructorParameters<typeof RFB>) => RfbConnection;
export type DesktopConnectionStatus = "connecting" | "connected" | "disconnected" | "failed";
type StreamQuality = "auto" | "sharp" | "data-saver";

const PRESETS = {
  auto: { qualityLevel: 6, compressionLevel: 2 },
  sharp: { qualityLevel: 9, compressionLevel: 2 },
  "data-saver": { qualityLevel: 3, compressionLevel: 6 },
} satisfies Record<StreamQuality, Pick<RfbConnection, "qualityLevel" | "compressionLevel">>;

export function LiveDesktopFrame({
  credentials: { url, password },
  quality,
  createRfb,
  onConnectionChange,
}: {
  credentials: DesktopStreamCredentials;
  quality: StreamQuality;
  createRfb?: RfbFactory | Promise<RfbFactory>;
  onConnectionChange?: (status: DesktopConnectionStatus) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const connection = useRef<RfbConnection | null>(null);
  const [status, setStatus] = useState<DesktopConnectionStatus>("connecting");
  const [attempt, setAttempt] = useState(0);
  const report = useEffectEvent((next: DesktopConnectionStatus) => {
    setStatus(next);
    onConnectionChange?.(next);
  });
  const configureQuality = useEffectEvent((rfb: RfbConnection) => {
    rfb.qualityLevel = PRESETS[quality].qualityLevel;
    rfb.compressionLevel = PRESETS[quality].compressionLevel;
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry deliberately starts a fresh transport generation.
  useEffect(() => {
    const container = viewport.current;
    if (!container) return;
    // Retired noVNC instances may remove their screen asynchronously during disconnect.
    // Give each connection its own target so that cleanup cannot touch its successor.
    const target = document.createElement("div");
    target.className = styles.target ?? "";
    container.append(target);
    let active = true;
    let rfb: RfbConnection | null = null;
    let released = false;
    const connected = () => {
      if (active) report("connected");
    };
    const disconnected = () => finish("disconnected");
    const failed = () => finish("failed");
    const release = () => {
      if (released) return;
      released = true;
      if (rfb) {
        rfb.removeEventListener("connect", connected);
        rfb.removeEventListener("disconnect", disconnected);
        rfb.removeEventListener("securityfailure", failed);
        rfb.removeEventListener("credentialsrequired", failed);
        if (connection.current === rfb) connection.current = null;
        rfb.disconnect();
      }
      target.remove();
    };
    const finish = (next: "failed" | "disconnected") => {
      if (!active) return;
      active = false;
      release();
      report(next);
    };
    report("connecting");
    const connect = async () => {
      try {
        let factory = await createRfb;
        if (!factory) {
          const [module, logging]: [
            { default: typeof RFB | { default: typeof RFB } },
            typeof import("@novnc/novnc/lib/util/logging"),
          ] = await Promise.all([
            import("@novnc/novnc/lib/rfb"),
            import("@novnc/novnc/lib/util/logging"),
          ]);
          if (!active) return;
          // Server failure reasons are untrusted and may echo private transport data.
          logging.initLogging("none");
          // CommonJS loaders can retain Babel’s default-export wrapper.
          const Client = "default" in module.default ? module.default.default : module.default;
          factory = (...args) => new Client(...args);
        }
        if (!active) return;
        rfb = factory(target, url, {
          shared: true,
          credentials: { username: "", target: "", password },
        });
        // Never expose a writable VNC mode. Owner input belongs to the server-gated overlay.
        // noVNC's viewOnly also suppresses incoming and outgoing clipboard contents.
        rfb.viewOnly = true;
        rfb.resizeSession = false;
        rfb.scaleViewport = true;
        rfb.focusOnClick = false;
        rfb.background = "var(--color-surface)";
        configureQuality(rfb);
        rfb.addEventListener("connect", connected);
        rfb.addEventListener("disconnect", disconnected);
        rfb.addEventListener("securityfailure", failed);
        rfb.addEventListener("credentialsrequired", failed);
        connection.current = rfb;
      } catch {
        finish("failed");
      }
    };
    void connect();
    return () => {
      active = false;
      release();
    };
  }, [url, password, createRfb, attempt]);

  useEffect(() => {
    const rfb = connection.current;
    if (rfb) {
      rfb.qualityLevel = PRESETS[quality].qualityLevel;
      rfb.compressionLevel = PRESETS[quality].compressionLevel;
    }
  }, [quality]);

  const failed = status === "failed" || status === "disconnected";
  return (
    <div
      ref={root}
      className={styles.frame}
      role="application"
      aria-label="Remote computer"
      aria-busy={status === "connecting"}
    >
      <div ref={viewport} className={styles.viewport} aria-hidden="true" inert />
      {status === "connecting" ? (
        <div className={styles.state}>
          <LitBox paletteRef={root} faceClassName={styles.card ?? ""}>
            <p role="status">Connecting to Nap's computer…</p>
          </LitBox>
        </div>
      ) : failed ? (
        <div className={styles.state}>
          <div className={styles.card}>
            <p role="status">Failed to connect to Nap's computer</p>
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              Retry
            </button>
          </div>
        </div>
      ) : (
        <span role="status" className="sr-only">
          Live
        </span>
      )}
    </div>
  );
}
