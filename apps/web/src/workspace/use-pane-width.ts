"use client";

/**
 * A divider's position, as state.
 *
 * The arithmetic and the storage live in `split.ts`, where they are checkable without a DOM; what
 * is left here is the part that genuinely needs a browser — reading the container's width,
 * following a pointer, and writing the result down when the drag ends.
 *
 * It takes the split rather than naming one, because there are two dividers now and they differ
 * only in their bounds and their storage key. See `split.ts`.
 *
 * **The width is read after mount, never during render.** `localStorage` and `window.innerWidth`
 * do not exist on the server, and a first render that reached for either would either crash the
 * render or produce markup that disagrees with the client's — which React reports as a hydration
 * mismatch. So the fallback is rendered first and the stored width arrives a frame later.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Split } from "./split.ts";

/** How far one arrow key moves a divider. Coarse enough to be useful, fine enough to aim. */
const STEP = 24;

export function usePaneWidth(
  split: Split,
  /** What to render before the stored width has been read. */
  fallback: number,
): {
  width: number;
  /** Put on the element the divider is measured against. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  onGrab: (event: React.PointerEvent) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
} {
  const [width, setWidth] = useState(fallback);
  const containerRef = useRef<HTMLDivElement>(null);

  /**
   * What this divider is allowed to divide.
   *
   * The container rather than the window, because the second divider does not span one: the file
   * tree splits the workbench, which is already whatever is left after the chat. Measured against
   * the window it would be allowed 40% of the whole screen — most of the pane it sits inside.
   * The viewport is the fallback for the first pass, before the element exists.
   */
  const available = useCallback(() => containerRef.current?.clientWidth || window.innerWidth, []);

  useEffect(() => {
    setWidth(split.read(window.localStorage, available()));
  }, [split, available]);

  const commit = useCallback(
    (next: number) => {
      setWidth(next);
      split.write(window.localStorage, next);
    },
    [split],
  );

  /**
   * Dragging is bound to the *window*, not to the handle: a pointer moving faster than React
   * re-renders leaves the handle behind, and a listener on the handle alone would drop the drag
   * the moment that happened.
   */
  const onGrab = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      const leftEdge = containerRef.current?.getBoundingClientRect().left ?? 0;
      const viewportWidth = available();

      const move = (moved: PointerEvent) => {
        setWidth(split.widthFrom({ pointerX: moved.clientX, leftEdge, viewportWidth }));
      };

      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        // Written once, at the end: a write per pointer event is a hundred writes a second.
        setWidth((current) => {
          split.write(window.localStorage, current);
          return current;
        });
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [split, available],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (direction === 0) return;

      event.preventDefault();
      commit(split.clamp(width + direction * STEP, available()));
    },
    [commit, split, width, available],
  );

  return { width, containerRef, onGrab, onKeyDown };
}
