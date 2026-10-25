"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type StoryChapter,
  type StoryDemoMessage,
  StoryDemoMessageSchema,
  type StoryThreadId,
} from "./story-demo-protocol.ts";
import { useSpaceScale } from "./use-space-scale.ts";

export function StoryDesktopPreview({
  chapter,
  onBuild,
  onDescribe,
  onReady,
  onInteract,
  threadId,
  onThreadChange,
}: {
  chapter: StoryChapter;
  onBuild: () => void;
  onDescribe: () => void;
  onReady: () => void;
  onInteract: () => void;
  threadId: StoryThreadId;
  onThreadChange: (threadId: StoryThreadId, chapter: StoryChapter) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const [compact, setCompact] = useState(false);
  const width = compact ? 390 : 1200;
  const height = compact ? 640 : 760;
  useSpaceScale(host, width);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const fit = () => setCompact(element.getBoundingClientRect().width < 600);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [initial] = useState({ threadId, chapter });
  const callbacks = useRef({
    chapter,
    threadId,
    onBuild,
    onDescribe,
    onReady,
    onInteract,
    onThreadChange,
  });
  callbacks.current = {
    chapter,
    threadId,
    onBuild,
    onDescribe,
    onReady,
    onInteract,
    onThreadChange,
  };
  const send = useCallback((message: StoryDemoMessage) => {
    iframe.current?.contentWindow?.postMessage(message, window.location.origin);
  }, []);
  useEffect(() => {
    send({ source: "nap-story-demo", type: "stage", chapter });
  }, [chapter, send]);
  useEffect(() => {
    send({ source: "nap-story-demo", type: "select-thread", threadId });
  }, [threadId, send]);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== iframe.current?.contentWindow)
        return;
      const parsed = StoryDemoMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const current = callbacks.current;
      switch (parsed.data.type) {
        case "ready":
          send({
            source: "nap-story-demo",
            type: "initialize",
            threadId: current.threadId,
            chapter: current.chapter,
          });
          current.onReady();
          break;
        case "build":
          current.onBuild();
          break;
        case "describe":
          current.onDescribe();
          break;
        case "interact":
          current.onInteract();
          break;
        case "thread-selected":
          current.onThreadChange(parsed.data.threadId, parsed.data.chapter);
          break;
        case "stage":
        case "initialize":
        case "select-thread":
          break;
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [send]);
  return (
    <div ref={host} className="ps-desktop-viewport" style={{ aspectRatio: `${width} / ${height}` }}>
      <iframe
        ref={iframe}
        src={`/demo/landing?thread=${initial.threadId}&chapter=${initial.chapter}`}
        title="Interactive Nap desktop walkthrough"
        width={width}
        height={height}
        className="ps-desktop-iframe"
      />
    </div>
  );
}
