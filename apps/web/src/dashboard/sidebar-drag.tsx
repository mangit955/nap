"use client";

/**
 * Dragging rows between the sidebar's shelves, with `@dnd-kit`.
 *
 * This is the only module that imports `@dnd-kit`, and the session list loads it with a dynamic
 * `import()` — so the landing page, which draws a sidebar nobody can drag, never downloads it,
 * and the pages that can drag fetch it after their first paint rather than before it.
 *
 * Everything that decides what a drop *means* is in `sidebar-drop.ts`; this file only reports
 * which row was let go over which item. Rows are moved by the mouse after 5px, or by a finger
 * after a 250ms press, so a click, a scroll and a drag stay three different gestures. The
 * keyboard's way to move a row is its context menu: Pin, Settle and Un-settle do what a drop
 * does, and a sortable keyboard sensor would fight the arrow keys that move between rows.
 */

import {
  closestCenter,
  DndContext,
  MeasuringStrategy,
  type Modifier,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, type SortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type ReactNode, useMemo, useRef } from "react";

/**
 * The boundaries and an empty Settled shelf appear when a drag starts, which moves every row
 * below them. Rects measured before that would put each drop target where it used to be, so
 * they are measured again while the pointer moves — a few cheap reads every 50ms.
 */
const MEASURING = { droppable: { strategy: MeasuringStrategy.Always, frequency: 50 } };

/**
 * A browser still fires the click that ends a drag on the row's link, and dnd-kit only stops
 * that click's propagation, not its default — which would follow the link. This swallows it.
 */
function swallowNextClick() {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  // If no click follows — the drop landed over another element — stop waiting for one.
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

/**
 * How the rows make room for the one being dragged. dnd-kit's vertical list strategy assumes one
 * evenly spaced list, and the sidebar is not one: the shelves sit at the bottom past a gap, so
 * a row crossing it would shift by the whole gap, and the shelf headers would slide up to meet
 * the rows. Here each row shifts by exactly the dragged row's height, and the headers in
 * `fixed` stay where they are.
 */
function shelvesStrategy(fixed: ReadonlySet<number>): SortingStrategy {
  return ({ activeIndex, activeNodeRect, index, rects, overIndex }) => {
    if (fixed.has(index)) return null;
    const active = rects[activeIndex] ?? activeNodeRect;
    if (!active) return null;
    const shift = (y: number) => ({ x: 0, y, scaleX: 1, scaleY: 1 });
    if (index > activeIndex && index <= overIndex) return shift(-active.height);
    if (index < activeIndex && index >= overIndex) return shift(active.height);
    return null;
  };
}

export function DragLayer({
  ids,
  fixed,
  onDragStart,
  onDragOver,
  onDragEnd,
  children,
}: {
  /** Every sortable item in list order: rows and markers alike. */
  ids: readonly string[];
  /** Items that never move to make room — the shelf headers. */
  fixed: ReadonlySet<string>;
  onDragStart: (id: string) => void;
  onDragOver: (id: string, overId: string | undefined) => void;
  /** `overId` is absent for a drag let go outside the list, or cancelled with Escape. */
  onDragEnd: (id: string, overId: string | undefined) => void;
  children: ReactNode;
}) {
  /**
   * Where the dragged row's top was at the instant the drag began. The boundaries appear in the
   * same moment and push it down, after dnd-kit has taken the pointer's offset into the row —
   * so without this the card under the pointer would sit a boundary's height below it, and
   * every drop would land a row low. Measured from the DOM before React draws them.
   */
  const startTop = useRef<number>(undefined);
  // Up and down only, and anchored to where the row was when it was picked up.
  const anchored: Modifier = ({ transform, activeNodeRect }) => ({
    ...transform,
    x: 0,
    y:
      transform.y +
      (startTop.current !== undefined && activeNodeRect
        ? startTop.current - activeNodeRect.top
        : 0),
  });
  const strategy = useMemo(
    () => shelvesStrategy(new Set(ids.flatMap((id, index) => (fixed.has(id) ? [index] : [])))),
    [ids, fixed],
  );
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      measuring={MEASURING}
      modifiers={[anchored]}
      onDragStart={({ active: started }) => {
        startTop.current = document
          .querySelector(`[data-row-id="${window.CSS.escape(String(started.id))}"]`)
          ?.getBoundingClientRect().top;
        onDragStart(String(started.id));
      }}
      onDragOver={({ active: moving, over }) =>
        onDragOver(String(moving.id), over ? String(over.id) : undefined)
      }
      onDragEnd={({ active: ended, over }) => {
        swallowNextClick();
        onDragEnd(String(ended.id), over ? String(over.id) : undefined);
      }}
      onDragCancel={({ active: cancelled }) => onDragEnd(String(cancelled.id), undefined)}
    >
      <SortableContext items={[...ids]} strategy={strategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

/**
 * A row, or a marker, that takes part in sorting. Only the pointer listeners are spread: the
 * sortable's own attributes would make the `<li>` a focusable button, and the row's link is the
 * one stop a keyboard should make.
 */
export function SortableShell({
  id,
  marker = false,
  disabled = false,
  as: Element = "li",
  className = "",
  children,
}: {
  id: string;
  /** Markers mark a boundary: something to drop by, never something to pick up. */
  marker?: boolean;
  disabled?: boolean;
  as?: "li" | "div";
  className?: string;
  children?: ReactNode;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id,
    disabled: { draggable: marker || disabled, droppable: false },
  });
  return (
    <Element
      ref={setNodeRef}
      data-row-id={marker ? undefined : id}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      // The row itself is what moves — no overlay copy, whose rect dnd-kit measures at a moment
      // of its own and so cannot be anchored reliably. Lifted above its neighbours while held.
      className={`${className} ${isDragging ? "relative z-10 rounded-md bg-sidebar shadow-raised" : ""}`}
      {...(marker ? {} : listeners)}
    >
      {children}
    </Element>
  );
}
