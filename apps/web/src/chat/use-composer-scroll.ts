"use client";

import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const GESTURE_RESET_MS = 120;
const COLLAPSE_THRESHOLD = 24;

/** T3's resting composer follows reading intent, never a streaming/layout scroll event. */
export function useComposerScroll({
  timeline,
  composer,
  eligible,
}: {
  timeline: RefObject<HTMLElement | null> | undefined;
  composer: RefObject<HTMLDivElement | null>;
  eligible: boolean;
}) {
  const [desktop, setDesktop] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [away, setAway] = useState(false);
  const gesture = useRef({ distance: 0, lastAt: Number.NEGATIVE_INFINITY, suppressed: false });
  const windowRefocus = useRef(false);
  const eligibleRef = useRef(eligible);
  eligibleRef.current = eligible;
  const resting = desktop && eligible && collapsed;
  const restingRef = useRef(resting);
  restingRef.current = resting;

  const expand = useCallback(() => {
    if (performance.now() - gesture.current.lastAt <= GESTURE_RESET_MS) {
      gesture.current.suppressed = true;
    }
    setCollapsed(false);
  }, []);

  const focusEditor = () => {
    if (!windowRefocus.current) expand();
  };

  const scrollToEnd = () => {
    expand();
    const node = timeline?.current;
    if (node !== null && node !== undefined) {
      node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    }
    setAway(false);
  };

  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!eligible || !desktop) setCollapsed(false);
  }, [eligible, desktop]);

  // Returning to the window refocuses its previous editor. That is not an editing gesture.
  useEffect(() => {
    let frame: number | undefined;
    const refocus = () => {
      windowRefocus.current = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        windowRefocus.current = false;
      });
    };
    window.addEventListener("focus", refocus);
    return () => {
      window.removeEventListener("focus", refocus);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, []);

  useLayoutEffect(() => {
    const node = timeline?.current;
    if (!node) return;
    const update = () => {
      const atEnd = node.scrollHeight - node.clientHeight - node.scrollTop <= 4;
      setAway(!atEnd);
      if (atEnd) setCollapsed(false);
    };
    update();
    node.addEventListener("scroll", update, { passive: true });
    return () => node.removeEventListener("scroll", update);
  }, [timeline]);

  useEffect(() => {
    const node = timeline?.current;
    if (!desktop || !node) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reset = () => {
      gesture.current = { distance: 0, lastAt: Number.NEGATIVE_INFINITY, suppressed: false };
    };
    const canCollapse = () => {
      const root = composer.current;
      return (
        eligibleRef.current &&
        node.scrollHeight > node.clientHeight + 1 &&
        // Open popups own their placement and focus until dismissed.
        !root?.querySelector('details[open]:not(.composer-queue), [aria-expanded="true"]') &&
        (root === null || root.clientWidth === 0 || root.clientWidth >= 320)
      );
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || !(event.target instanceof Element)) return;
      if (!node.contains(event.target) && !gesture.current.suppressed) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(reset, GESTURE_RESET_MS);
      const state = gesture.current;
      state.lastAt = performance.now();
      const targetsTimeline = isTimelineScrollTarget(event.target, node, event.deltaY);
      const canMove =
        event.deltaY < 0
          ? node.scrollTop > 0
          : node.scrollTop < node.scrollHeight - node.clientHeight - 1;
      if (state.suppressed || !canCollapse() || !targetsTimeline || !canMove) {
        state.distance = 0;
        return;
      }
      state.distance +=
        Math.abs(event.deltaY) *
        (event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? node.clientHeight
            : 1);
      if (state.distance >= COLLAPSE_THRESHOLD) {
        state.distance = 0;
        setCollapsed(true);
      }
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        !(event.target instanceof Element) ||
        !node.contains(event.target) ||
        event.target.closest('input, textarea, select, button, a, [contenteditable="true"]') ||
        !canCollapse()
      )
        return;
      const upward = event.key === "PageUp" || event.key === "Home";
      const downward = event.key === "PageDown" || event.key === "End";
      if (!upward && !downward) return;
      const canMove = upward
        ? node.scrollTop > 1
        : node.scrollTop < node.scrollHeight - node.clientHeight - 1;
      if (canMove && isTimelineScrollTarget(event.target, node, upward ? -1 : 1)) {
        setCollapsed(true);
      }
    };
    document.addEventListener("wheel", wheel, { capture: true, passive: true });
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("wheel", wheel, true);
      document.removeEventListener("keydown", key, true);
      if (timer !== undefined) clearTimeout(timer);
      reset();
    };
  }, [desktop, timeline, composer]);

  return { resting, restingRef, away, expand, focusEditor, scrollToEnd };
}

function isTimelineScrollTarget(target: Element, timeline: HTMLElement, deltaY: number) {
  if (!timeline.contains(target) || deltaY === 0) return false;
  for (
    let element: Element | null = target;
    element && element !== timeline;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element);
    if (style.overflowY !== "auto" && style.overflowY !== "scroll") continue;
    const canScroll =
      deltaY < 0
        ? element.scrollTop > 0
        : element.scrollTop < element.scrollHeight - element.clientHeight;
    if (
      canScroll ||
      style.overscrollBehaviorY === "contain" ||
      style.overscrollBehaviorY === "none"
    )
      return false;
  }
  return true;
}
