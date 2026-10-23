"use client";

import { AlarmClock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { snoozePresets } from "./session-rows.ts";

/**
 * The clock on a row's hover controls, and the presets it opens: T3's `SnoozeMenuButton`.
 *
 * Drawn into `document.body` and placed from the button's own rectangle, because the row clips
 * everything inside it — a menu inside the row would be cut off at the row's bottom edge.
 */
export function SnoozeMenu({
  name,
  disabled = false,
  onSnooze,
  onOpenChange,
}: {
  name: string;
  disabled?: boolean;
  onSnooze: (until: string) => void;
  /** So the row can keep its hover controls showing while the menu is open over something else. */
  onOpenChange?: (open: boolean) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const open = position !== undefined;

  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        setPosition(undefined);
    };
    const close = () => setPosition(undefined);
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", close);
    const scroll = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      close();
    };
    window.addEventListener("scroll", scroll, true);
    menu.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        disabled={disabled}
        type="button"
        aria-label={`Snooze ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Snooze"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const rect = trigger.current?.getBoundingClientRect();
          if (open || !rect) setPosition(undefined);
          else
            setPosition({
              top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 260)),
              left: Math.max(8, Math.min(rect.right - 224, window.innerWidth - 232)),
            });
        }}
        className="inline-flex h-5 cursor-pointer items-center rounded-md px-1.5 text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      >
        <AlarmClock aria-hidden className="size-3.5" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label={`Snooze ${name}`}
            style={position}
            className="composer-surface nap-float fixed z-50 max-h-[calc(100dvh-16px)] overflow-y-auto w-56 rounded-[10px] p-1 [--float-origin:top_right]"
            onKeyDown={(event) => {
              const items = [
                ...event.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']"),
              ];
              const index =
                document.activeElement instanceof HTMLElement
                  ? items.indexOf(document.activeElement)
                  : -1;
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setPosition(undefined);
                trigger.current?.focus();
              } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                items[(index + step + items.length) % items.length]?.focus();
              }
            }}
          >
            {snoozePresets(new Date()).map((preset) => (
              <button
                key={preset.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setPosition(undefined);
                  onSnooze(preset.snoozedUntil);
                  trigger.current?.focus();
                }}
                className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink-2 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:outline-none"
              >
                {preset.label}
                <span className="text-xs text-muted tabular-nums">{preset.whenLabel}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
