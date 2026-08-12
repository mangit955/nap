"use client";

/**
 * The divider's position, as state.
 *
 * The arithmetic and the storage live in `split.ts`, where they are checkable without a DOM;
 * what is left here is the part that genuinely needs a browser — reading the window's width,
 * following a pointer, and writing the result down when the drag ends.
 *
 * **The width is read after mount, never during render.** `localStorage` and `window.innerWidth`
 * do not exist on the server, and a first render that reached for either would either crash the
 * render or produce markup that disagrees with the client's — which React reports as a hydration
 * mismatch. So the default is rendered first and the stored width arrives a frame later.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  chatWidthFrom,
  clampChatWidth,
  DEFAULT_CHAT_WIDTH,
  readChatWidth,
  writeChatWidth,
} from "./split.ts";

/** How far one arrow key moves the divider. Coarse enough to be useful, fine enough to aim. */
const STEP = 24;

export function useChatWidth(): {
  width: number;
  /** Put on the element the divider is measured against. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  onGrab: (event: React.PointerEvent) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
} {
  const [width, setWidth] = useState(DEFAULT_CHAT_WIDTH);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setWidth(readChatWidth(window.localStorage, window.innerWidth));
  }, []);

  const commit = useCallback((next: number) => {
    setWidth(next);
    writeChatWidth(window.localStorage, next);
  }, []);

  /**
   * Dragging is bound to the *window*, not to the handle: a pointer moving faster than React
   * re-renders leaves the handle behind, and a listener on the handle alone would drop the drag
   * the moment that happened. Capture is released on the first pointerup either way.
   */
  const onGrab = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const leftEdge = containerRef.current?.getBoundingClientRect().left ?? 0;

    const move = (moved: PointerEvent) => {
      setWidth(
        chatWidthFrom({
          pointerX: moved.clientX,
          leftEdge,
          viewportWidth: window.innerWidth,
        }),
      );
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      // Written once, at the end: a write per pointer event is a hundred writes a second.
      setWidth((current) => {
        writeChatWidth(window.localStorage, current);
        return current;
      });
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (direction === 0) return;

      event.preventDefault();
      commit(clampChatWidth(width + direction * STEP, window.innerWidth));
    },
    [commit, width],
  );

  return { width, containerRef, onGrab, onKeyDown };
}
