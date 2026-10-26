"use client";

import { Code2, GitBranch, Pause, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  STORY_THREAD_IDS,
  STORY_THREAD_LABELS,
  type StoryThreadId,
} from "./story-demo-protocol.ts";
import { StoryDesktopPreview } from "./story-desktop-preview.tsx";
import "./product-story.css";

const CHAPTERS = [
  {
    id: "describe",
    number: "01",
    label: "Describe",
    title: "Start with an idea.",
    body: "A tool you need. A side project you've been putting off. Tell nap what you want to make.",
    status: "Your words are the starting point.",
  },
  {
    id: "build",
    number: "02",
    label: "Build & check",
    title: "Leave the building to nap.",
    body: "It writes the code, runs the checks, and fixes what fails. You don't need to watch every step.",
    status: "Writing files. Running checks. Saving progress.",
  },
  {
    id: "ready",
    number: "03",
    label: "Come back",
    title: "Pick up something real.",
    body: "A running app, a saved checkpoint, and every line of code. Ready for your next idea.",
    status: "A working preview. Code you can keep.",
  },
] as const;
type Chapter = (typeof CHAPTERS)[number]["id"];
type Playback = "playing" | "paused" | "manual";
export function ProductStory() {
  const frame = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const [visible, setVisible] = useState(false);
  const [entered, setEntered] = useState(false);
  const [threadId, setThreadId] = useState<StoryThreadId>("finance");
  const [chapter, setChapter] = useState<Chapter>("describe");
  const [playback, setPlayback] = useState<Playback>("manual");
  const [run, setRun] = useState(0);
  const [demoReady, setDemoReady] = useState(false);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const observer = new IntersectionObserver(
      ([entry]) => {
        const entered = entry?.isIntersecting ?? false;
        setVisible(entered);
        if (entered && !started.current) {
          started.current = true;
          if (!motion.matches) setPlayback("playing");
        }
      },
      { threshold: 0.55 },
    );
    const onMotionChange = () => {
      if (motion.matches) setPlayback("manual");
    };
    const reveal = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setEntered(true);
          reveal.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    if (heading.current) reveal.observe(heading.current);
    observer.observe(element);
    motion.addEventListener("change", onMotionChange);
    return () => {
      observer.disconnect();
      reveal.disconnect();
      motion.removeEventListener("change", onMotionChange);
    };
  }, []);

  useEffect(() => {
    if (!visible || !demoReady || playback !== "playing" || chapter === "ready") return;
    const timer = setTimeout(
      () => setChapter(chapter === "describe" ? "build" : "ready"),
      chapter === "describe" ? 2100 : 2800,
    );
    return () => clearTimeout(timer);
  }, [chapter, playback, visible, demoReady]);

  const select = useCallback((next: Chapter) => {
    started.current = true;
    setPlayback("manual");
    setChapter(next);
  }, []);
  const replay = useCallback(() => {
    setDemoReady(false);
    started.current = true;
    setRun((value) => value + 1);
    setChapter("describe");
    setPlayback("playing");
  }, []);
  const build = useCallback(() => {
    started.current = true;
    setChapter("build");
    setPlayback("playing");
  }, []);
  const onDemoReady = useCallback(() => setDemoReady(true), []);
  const onDescribe = useCallback(() => select("describe"), [select]);
  const onInteract = useCallback(() => {
    started.current = true;
    setPlayback("manual");
  }, []);
  const onThreadChange = useCallback((id: StoryThreadId, next: Chapter) => {
    started.current = true;
    setPlayback("manual");
    setThreadId(id);
    setChapter(next);
  }, []);
  const active = CHAPTERS.find((item) => item.id === chapter) ?? CHAPTERS[0];
  const completed = chapter === "ready";

  return (
    <section
      id="why"
      className="lp-story"
      aria-labelledby="why-title"
      data-chapter={chapter}
      data-playback={completed ? "complete" : playback}
      data-visible={visible}
      data-entered={entered}
      data-thread={threadId}
    >
      <div className="lp-story-content lp-container">
        <div className="ps-heading" ref={heading}>
          <div>
            <span className="lp-eyebrow">FROM FIRST THOUGHT TO FIRST VERSION</span>
            <h2 id="why-title" className="lp-serif">
              <span className="ps-title-mask">
                <span>You describe it.</span>
              </span>
              <span className="ps-title-mask">
                <span>Nap takes it from here.</span>
              </span>
            </h2>
          </div>
          <p>
            Describe what you want to make.
            <br />
            Come back to an app you can use.
          </p>
        </div>
        <div className="ps-layout">
          <div className="ps-sidebar">
            <div
              className="ps-chapters"
              role="tablist"
              aria-label="How nap works"
              aria-orientation="horizontal"
            >
              {CHAPTERS.map((item, index) => (
                <button
                  type="button"
                  role="tab"
                  key={item.id}
                  id={`chapter-${item.id}`}
                  aria-selected={chapter === item.id}
                  aria-controls={`scene-${item.id}`}
                  tabIndex={chapter === item.id ? 0 : -1}
                  onFocus={() => {
                    started.current = true;
                    setPlayback("manual");
                  }}
                  onClick={() => select(item.id)}
                  onKeyDown={(event) => {
                    const next =
                      event.key === "ArrowDown" || event.key === "ArrowRight"
                        ? CHAPTERS[(index + 1) % CHAPTERS.length]
                        : event.key === "ArrowUp" || event.key === "ArrowLeft"
                          ? CHAPTERS[(index + CHAPTERS.length - 1) % CHAPTERS.length]
                          : event.key === "Home"
                            ? CHAPTERS[0]
                            : event.key === "End"
                              ? CHAPTERS[2]
                              : undefined;
                    if (next) {
                      event.preventDefault();
                      select(next.id);
                      document.getElementById(`chapter-${next.id}`)?.focus({ preventScroll: true });
                    }
                  }}
                >
                  <span className="ps-step-number">{item.number}</span>
                  <span className="ps-step-label">{item.label}</span>
                </button>
              ))}
            </div>
            <div className="ps-copy-slot">
              <div className="ps-active-copy" key={chapter}>
                <span className="ps-copy-kicker">{active.number} / 03</span>
                <h3>{active.title}</h3>
                <p>{active.body}</p>
              </div>
            </div>
            <div className="ps-sidebar-note">
              <GitBranch size={13} />
              <span>Your files. Your checks. Your project.</span>
            </div>
          </div>
          <div className="ps-demo" ref={frame}>
            <div className="ps-workspace">
              <div className="ps-scenes">
                <div
                  id={`scene-${chapter}`}
                  role="tabpanel"
                  aria-labelledby={`chapter-${chapter}`}
                  aria-hidden="false"
                  data-active="true"
                  className="lp-story-scene"
                >
                  <StoryDesktopPreview
                    key={run}
                    chapter={chapter}
                    onBuild={build}
                    onDescribe={onDescribe}
                    onReady={onDemoReady}
                    onInteract={onInteract}
                    threadId={threadId}
                    onThreadChange={onThreadChange}
                  />
                </div>
                {CHAPTERS.filter((item) => item.id !== chapter).map((item) => (
                  <div
                    key={item.id}
                    id={`scene-${item.id}`}
                    role="tabpanel"
                    aria-labelledby={`chapter-${item.id}`}
                    aria-hidden="true"
                    inert
                    hidden
                    className="lp-story-scene"
                  />
                ))}
              </div>
            </div>
            <div className="ps-demo-footer">
              <fieldset className="ps-thread-switcher" aria-label="Example threads">
                <legend className="sr-only">Switch example thread</legend>
                {STORY_THREAD_IDS.map((id) => (
                  <button
                    type="button"
                    key={id}
                    aria-pressed={threadId === id}
                    onClick={() => {
                      started.current = true;
                      setPlayback("manual");
                      setThreadId(id);
                    }}
                  >
                    {STORY_THREAD_LABELS[id]}
                  </button>
                ))}
              </fieldset>
              <span className="sr-only" role="status">
                {active.status}
              </span>
              <button
                type="button"
                onClick={
                  completed || playback === "manual"
                    ? replay
                    : () => setPlayback(playback === "playing" ? "paused" : "playing")
                }
                aria-label={
                  completed || playback === "manual"
                    ? "Replay the walkthrough"
                    : playback === "playing"
                      ? "Pause the walkthrough"
                      : "Play the walkthrough"
                }
              >
                {completed || playback === "manual" ? (
                  <RotateCcw size={12} />
                ) : playback === "playing" ? (
                  <Pause size={12} />
                ) : (
                  <Play size={12} />
                )}
                {completed || playback === "manual"
                  ? "Replay"
                  : playback === "playing"
                    ? "Pause"
                    : "Play"}
              </button>
            </div>
            <span className="ps-demo-caption">
              <Code2 size={11} /> THREE IDEAS. THREE WORKING APPS.{" "}
              <span>SWITCH THREADS TO EXPLORE</span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
