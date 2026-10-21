"use client";

/**
 * Files dragged over the chat, and whether one is being dragged right now.
 *
 * The composer always accepted a drop, and nothing on screen said it would: a file dragged over
 * the chat looked exactly like a file dragged over anything else. T3 Code answers with an overlay
 * across the whole chat and a ring on the composer while a drag is over it (MIT — see
 * `apps/web/THIRD_PARTY_NOTICES.md`), and so does this — the hook says *when*, the composer draws
 * it.
 *
 * The zone is an element rather than a ref, because the composer portals the overlay into it and
 * so needs it at render; the pane hands over its chat stage once it is mounted. With no zone, the
 * composer itself is the target (`reactHandlers`), which is what a composer on its own — and its
 * tests — has.
 *
 * Two things clear a drag that never dropped here. Leaving the zone for something outside it, and
 * `dragend` on the window, which is what fires when a drag is cancelled with Escape or dropped
 * outside the page altogether.
 */

import { type DragEvent as ReactDragEvent, useEffect, useMemo, useRef, useState } from "react";

/** Whether a drag is carrying files, which during the drag is known only from its `types`. */
function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export function useFileDrop({
  zone,
  enabled,
  onFiles,
}: {
  zone: HTMLElement | null | undefined;
  /** False while the composer cannot take an attachment — a turn is running. */
  enabled: boolean;
  onFiles: (files: File[]) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const latest = useRef({ enabled, onFiles });
  latest.current = { enabled, onFiles };

  useEffect(() => {
    if (!dragging) return;
    const clear = () => setDragging(false);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, [dragging]);

  const handlers = useMemo(
    () => ({
      dragenter(event: DragEvent) {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        if (latest.current.enabled) setDragging(true);
      },
      dragover(event: DragEvent) {
        if (!carriesFiles(event)) return;
        // Without this the browser takes the drop itself and navigates to the file.
        event.preventDefault();
        if (event.dataTransfer !== null) {
          event.dataTransfer.dropEffect = latest.current.enabled ? "copy" : "none";
        }
      },
      // The zone is passed in rather than read off the event: a React handler's native event has
      // React's root as its `currentTarget`, which contains everything.
      dragleave(event: DragEvent, zone: EventTarget | null = event.currentTarget) {
        const into = event.relatedTarget;
        if (zone instanceof Node && into instanceof Node && zone.contains(into)) return;
        setDragging(false);
      },
      drop(event: DragEvent) {
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length === 0 && !carriesFiles(event)) return;
        event.preventDefault();
        setDragging(false);
        if (latest.current.enabled && files.length > 0) latest.current.onFiles(files);
      },
    }),
    [],
  );

  useEffect(() => {
    if (zone === null || zone === undefined) return;
    const entries = Object.entries(handlers) as [
      keyof typeof handlers,
      (event: DragEvent) => void,
    ][];
    for (const [type, handler] of entries) zone.addEventListener(type, handler);
    return () => {
      for (const [type, handler] of entries) zone.removeEventListener(type, handler);
    };
  }, [zone, handlers]);

  const reactHandlers = useMemo(
    () => ({
      onDragEnter: (event: ReactDragEvent) => handlers.dragenter(event.nativeEvent),
      onDragOver: (event: ReactDragEvent) => handlers.dragover(event.nativeEvent),
      onDragLeave: (event: ReactDragEvent) =>
        handlers.dragleave(event.nativeEvent, event.currentTarget),
      onDrop: (event: ReactDragEvent) => handlers.drop(event.nativeEvent),
    }),
    [handlers],
  );

  return { dragging: dragging && enabled, reactHandlers };
}
