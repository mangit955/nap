"use client";

import type { ComputerAnnotation } from "@nap/shared/computer";
import {
  type KeyboardEvent,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "../ui/icons.tsx";
import styles from "./recording-viewer.module.css";

/** UI-owned projection. The caller supplies an authenticated owner API URL, never an object key. */
export type RecordingView = {
  videoUrl: string;
  downloadUrl: string;
  title: string;
  annotations: { annotation: ComputerAnnotation; timeMs: number }[];
  counts: { passed: number; failed: number; untested: number };
};

type Chapter = {
  id: string;
  label: string;
  description: string;
  timeMs: number;
  assertions: Extract<ComputerAnnotation, { type: "assertion" }>[];
  actions: { id: string; description: string }[];
};

function chaptersFor(annotations: RecordingView["annotations"]): Chapter[] {
  const setup: Chapter = {
    id: "setup",
    label: "Setup",
    description: "Prepare the app",
    timeMs: 0,
    assertions: [],
    actions: [],
  };
  const chapters = [setup];
  let chapter = setup;
  for (const { annotation, timeMs } of [...annotations].sort((a, b) => a.timeMs - b.timeMs)) {
    switch (annotation.type) {
      case "test_start":
        chapter = {
          id: `test:${annotation.id}`,
          label: `Test ${chapters.length}`,
          description: annotation.description,
          timeMs,
          assertions: [],
          actions: [],
        };
        chapters.push(chapter);
        break;
      case "setup":
      case "action":
        chapter.actions.push({
          id: `${timeMs}:${chapter.actions.length}`,
          description: annotation.description,
        });
        break;
      case "assertion": {
        const index = chapter.assertions.findIndex((assertion) => assertion.id === annotation.id);
        if (index < 0) chapter.assertions.push(annotation);
        else chapter.assertions[index] = annotation;
        break;
      }
      default: {
        const exhaustive: never = annotation;
        return exhaustive;
      }
    }
  }
  return chapters;
}

function chapterStatus(chapter: Chapter) {
  if (chapter.assertions.some((assertion) => assertion.result === "failed")) return "failed";
  if (
    chapter.assertions.length === 0 ||
    chapter.assertions.some((assertion) => assertion.result === "untested")
  )
    return "untested";
  return "passed";
}

function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function timelineMs(seconds: number) {
  // Annotations use integer milliseconds; native seeks may truncate to microseconds.
  return Math.round(seconds * 1000);
}

export function RecordingViewer({
  recording,
  onClose,
}: {
  recording: RecordingView | null;
  onClose: () => void;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const title = useId();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const previous = document.activeElement;
    const siblings = [...document.body.children].filter((element) => element !== overlay.current);
    const inert = siblings.map((element) => element.hasAttribute("inert"));
    siblings.forEach((element) => {
      element.setAttribute("inert", "");
    });
    close.current?.focus();
    return () => {
      siblings.forEach((element, index) => {
        if (!inert[index]) element.removeAttribute("inert");
      });
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [mounted]);

  useEffect(() => {
    if (mounted && (recording === null || !dialog.current?.contains(document.activeElement)))
      close.current?.focus();
  }, [mounted, recording]);

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
    if (event.key !== "Tab") return;
    const focusable = dialog.current?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), video[tabindex]",
    );
    const first = focusable?.[0];
    const last = focusable?.[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  if (!mounted) return null;
  return createPortal(
    <div className={styles.overlay} ref={overlay}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Test recording viewer"
        aria-describedby={title}
        className={styles.dialog}
        ref={dialog}
        onKeyDown={handleKey}
      >
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Test recording</p>
            <h2 id={title}>{recording?.title ?? "Test recording viewer"}</h2>
          </div>
          <button
            ref={close}
            type="button"
            onClick={onClose}
            aria-label="Close test recording viewer"
            className={styles.close}
          >
            <CloseIcon />
          </button>
        </header>
        {recording === null ? (
          <p className={styles.empty}>No browser test recordings in this session yet</p>
        ) : (
          <RecordingPlayer key={recording.videoUrl} recording={recording} />
        )}
      </div>
    </div>,
    document.body,
  );
}

function RecordingPlayer({ recording }: { recording: RecordingView }) {
  const video = useRef<HTMLVideoElement>(null);
  const alive = useRef(false);
  const chapters = useMemo(() => chaptersFor(recording.annotations), [recording.annotations]);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  // A paused review can select any chapter, including one sharing another's timestamp.
  // Null follows the media clock; a loop keeps its selected chapter's identity.
  const [selection, setSelection] = useState<{ index: number; loop: boolean } | null>({
    index: 0,
    loop: false,
  });
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState<string | null>(null);
  function chapterIndexAt(seconds: number) {
    return Math.max(
      0,
      chapters.findLastIndex((chapter) => chapter.timeMs <= timelineMs(seconds)),
    );
  }
  function chapterHasDuration(index: number) {
    const chapter = chapters[index];
    const next = chapters[index + 1];
    return chapter !== undefined && (next ? next.timeMs / 1000 : duration) > chapter.timeMs / 1000;
  }
  const currentIndex = selection?.index ?? chapterIndexAt(time);
  const loopIndex = selection?.loop ? selection.index : null;
  const current = chapters[currentIndex];

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  function play() {
    const element = video.current;
    if (element === null) return;
    setError(null);
    void element.play().catch(() => {
      if (alive.current) setError("Playback could not start. Press Play to try again.");
    });
  }

  useEffect(() => {
    const element = video.current;
    if (element === null) return;
    function onMetadata() {
      if (!Number.isFinite(element?.duration)) return;
      setDuration(element?.duration ?? 0);
      setReady(true);
    }
    function onPlay() {
      setPlaying(true);
      setTime(element?.currentTime ?? 0);
      if (loopIndex === null) setSelection(null);
    }
    function onPause() {
      setPlaying(false);
    }
    function onError() {
      setReady(false);
      setPlaying(false);
      setError("This recording could not be loaded. Close the viewer and try again.");
    }
    function onTime() {
      if (element === null) return;
      const loop = loopIndex === null ? undefined : chapters[loopIndex];
      const end = loopIndex === null ? undefined : chapters[loopIndex + 1];
      const timeMs = timelineMs(element.currentTime);
      if (
        loop &&
        (timeMs < loop.timeMs || timeMs >= (end ? end.timeMs : timelineMs(element.duration)))
      )
        element.currentTime = loop.timeMs / 1000;
      setTime(element.currentTime);
      if (!element.paused && loopIndex === null) setSelection(null);
    }
    function onEnded() {
      onTime();
      if (loopIndex === null) setPlaying(false);
      else
        void element?.play().catch(() => {
          if (alive.current) setError("Playback could not start. Press Play to try again.");
        });
    }
    element.addEventListener("loadedmetadata", onMetadata);
    element.addEventListener("durationchange", onMetadata);
    element.addEventListener("play", onPlay);
    element.addEventListener("pause", onPause);
    element.addEventListener("timeupdate", onTime);
    element.addEventListener("ended", onEnded);
    element.addEventListener("error", onError);
    if (element.readyState >= 1) onMetadata();
    return () => {
      element.removeEventListener("loadedmetadata", onMetadata);
      element.removeEventListener("durationchange", onMetadata);
      element.removeEventListener("play", onPlay);
      element.removeEventListener("pause", onPause);
      element.removeEventListener("timeupdate", onTime);
      element.removeEventListener("ended", onEnded);
      element.removeEventListener("error", onError);
    };
  }, [chapters, loopIndex]);

  useEffect(() => {
    const element = video.current;
    return () => {
      element?.pause();
    };
  }, []);

  function seek(index: number) {
    const chapter = chapters[index];
    if (!chapter || !ready || !video.current) return;
    video.current.currentTime = Math.min(chapter.timeMs / 1000, duration);
    setTime(video.current.currentTime);
    setSelection({ index, loop: loopIndex !== null && chapterHasDuration(index) });
  }

  const handleKey = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey)
      return;
    if (
      event.target instanceof HTMLElement &&
      event.target.closest("input, select, textarea, [contenteditable]")
    )
      return;
    if (
      event.key === " " &&
      ready &&
      !(event.target instanceof HTMLElement && event.target.closest("button, a"))
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (playing) video.current?.pause();
      else play();
    }
    if (event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      event.stopPropagation();
      seek(currentIndex + (event.key === "ArrowLeft" ? -1 : 1));
    }
  });

  useEffect(() => {
    const dialog = video.current?.closest("[role=dialog]");
    function onKey(event: Event) {
      if (event instanceof globalThis.KeyboardEvent) handleKey(event);
    }
    dialog?.addEventListener("keydown", onKey);
    return () => {
      dialog?.removeEventListener("keydown", onKey);
    };
  }, []);

  async function fullscreen() {
    try {
      if (!video.current?.requestFullscreen) throw new Error("Fullscreen unavailable");
      await video.current.requestFullscreen();
    } catch {
      if (alive.current) setError("Full screen is unavailable in this browser.");
    }
  }

  return (
    <section aria-label="Recording playback" className={styles.player}>
      <section className={styles.counts} aria-label="Assertion counts">
        <span data-status="passed">Passed {recording.counts.passed}</span>
        <span data-status="failed">Failed {recording.counts.failed}</span>
        <span data-status="untested">Untested {recording.counts.untested}</span>
      </section>
      <div className={styles.body}>
        <nav aria-label="Recording chapters" className={styles.rail}>
          {chapters.map((chapter, index) => (
            <button
              type="button"
              key={chapter.id}
              disabled={!ready}
              aria-current={index === currentIndex ? "step" : undefined}
              onClick={() => seek(index)}
            >
              <span className={styles.chapterLabel}>
                {chapter.label}
                <time>{clock(chapter.timeMs / 1000)}</time>
              </span>
              <span>{chapter.description}</span>
              {index > 0 && (
                <span className={styles.status} data-status={chapterStatus(chapter)}>
                  {chapterStatus(chapter)}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className={styles.stage}>
          {/* The source is silent. Annotation text below is its accessible companion. */}
          <video
            ref={video}
            tabIndex={0}
            src={recording.videoUrl}
            crossOrigin="use-credentials"
            aria-label="Test recording"
            muted
            playsInline
            preload="metadata"
            className={styles.video}
          >
            <track kind="captions" />
          </video>
          <div className={styles.controls}>
            <div className={styles.transport}>
              <button
                type="button"
                disabled={!ready}
                onClick={() => {
                  if (playing) video.current?.pause();
                  else play();
                }}
                aria-keyshortcuts="Space"
              >
                {playing ? "Pause recording" : "Play recording"}
              </button>
              <button
                type="button"
                disabled={!ready || currentIndex === 0}
                onClick={() => seek(currentIndex - 1)}
                aria-keyshortcuts="Shift+ArrowLeft"
              >
                Previous chapter
              </button>
              <button
                type="button"
                disabled={!ready || currentIndex >= chapters.length - 1}
                onClick={() => seek(currentIndex + 1)}
                aria-keyshortcuts="Shift+ArrowRight"
              >
                Next chapter
              </button>
              <span className={styles.timestamp}>
                {clock(time)} / {clock(duration)}
              </span>
            </div>
            <input
              aria-label="Recording position"
              type="range"
              min={0}
              max={duration}
              step={0.01}
              value={time}
              disabled={!ready}
              onChange={(event) => {
                if (!video.current) return;
                const value = Number(event.target.value);
                video.current.currentTime = value;
                setTime(value);
                const index = chapterIndexAt(value);
                setSelection(
                  loopIndex === null ? null : { index, loop: chapterHasDuration(index) },
                );
              }}
            />
            <div className={styles.options}>
              <button
                type="button"
                disabled={!ready || !chapterHasDuration(currentIndex)}
                aria-pressed={loopIndex !== null}
                onClick={() => setSelection({ index: currentIndex, loop: loopIndex === null })}
              >
                Loop current chapter
              </button>
              <label>
                Speed{" "}
                <select
                  aria-label="Playback speed"
                  value={speed}
                  disabled={!ready}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setSpeed(value);
                    if (video.current) video.current.playbackRate = value;
                  }}
                >
                  {[0.5, 1, 1.5, 2].map((value) => (
                    <option key={value} value={value}>
                      {value}×
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" disabled={!ready} onClick={() => void fullscreen()}>
                Full screen
              </button>
              <a href={recording.downloadUrl} download>
                Download recording
              </a>
            </div>
          </div>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          {!ready && !error && (
            <p role="status" className={styles.loading}>
              Loading recording…
            </p>
          )}
          <section aria-label="Current chapter" className={styles.detail}>
            <h3>
              {current?.label} · {current?.description}
            </h3>
            {ready && !chapterHasDuration(currentIndex) && (
              <p>This chapter has no playback duration and cannot be looped.</p>
            )}
            {current?.actions.map((action) => (
              <p key={action.id}>{action.description}</p>
            ))}
            <ul>
              {current?.assertions.map((assertion) => (
                <li key={assertion.id}>
                  <span>{assertion.expectation}</span>
                  <span className={styles.status} data-status={assertion.result}>
                    {assertion.result}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </section>
  );
}
