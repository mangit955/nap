"use client";

import { Tooltip as Base } from "@base-ui/react/tooltip";
import type { ReactElement } from "react";

/**
 * How long a pointer rests on a control before its tooltip appears. Long enough that sweeping
 * across the sidebar draws nothing, short enough to beat the browser's own `title`, which waits
 * about a second and then draws in the operating system's style.
 */
export const TOOLTIP_DELAY_MS = 450;

/**
 * Lets a tooltip open at once when another closed moments ago, so moving along a row of icons
 * after the first has shown reads each name without waiting out the delay again. Each tooltip
 * works without one; it is mounted once, around the dashboard frame.
 */
export const TooltipProvider = Base.Provider;

/**
 * The name of an icon-only control, drawn by the app on hover and on keyboard focus.
 *
 * The tooltip is for eyes only: Base UI does not point the control at it with
 * `aria-describedby`, so the control keeps its own `aria-label` and a screen reader reads that.
 * It replaces `title`, which a touch screen never shows and which the app cannot style or time.
 *
 * `shortcut` is drawn after the label only when one is given; most controls have none.
 * `disabled` keeps it shut, for a control whose own menu is open where the tooltip would land.
 */
export function Tooltip({
  label,
  shortcut,
  side = "bottom",
  disabled = false,
  children,
}: {
  label: string;
  shortcut?: string | undefined;
  side?: "top" | "bottom" | "left" | "right";
  disabled?: boolean;
  /** The control itself. Its own props, ref and handlers are kept. */
  children: ReactElement;
}) {
  return (
    <Base.Root disabled={disabled}>
      <Base.Trigger delay={TOOLTIP_DELAY_MS} render={children} />
      <Base.Portal>
        {/*
          Above the sidebar's menus (50) and its resize handle (45), which it can overhang. Hidden
          while Base UI marks its control scrolled out of view: a tooltip opened by keyboard focus
          stays open when the list scrolls, and would float over whatever the row was clipped by.
        */}
        <Base.Positioner
          side={side}
          sideOffset={6}
          className="z-[70] data-[anchor-hidden]:invisible"
        >
          <Base.Popup className={POPUP}>
            {label}
            {shortcut && <kbd className="font-sans text-muted">{shortcut}</kbd>}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}

/**
 * A quiet label rather than a card: no border, no shadow, no arrow, 11px type, and a 100ms fade
 * with no movement. Base UI marks the popup `data-instant` when it opens at once inside a
 * provider's group, and the fade is dropped there and for anyone who asks for reduced motion.
 */
const POPUP =
  "flex items-center gap-1.5 rounded-md bg-bubble px-[7px] py-[3px] text-2xs leading-4 text-ink-2 whitespace-nowrap select-none transition-opacity duration-100 ease-out data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 data-[instant]:transition-none motion-reduce:transition-none";
