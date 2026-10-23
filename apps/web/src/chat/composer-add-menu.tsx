"use client";

import { useEffect, useRef, useState } from "react";
import { CONTROL_CLASS } from "./composer-controls.tsx";
import { MEDIA_ACCEPT } from "./use-media-attachments.ts";

export function ComposerAddMenu({
  disabled,
  mediaSupported,
  onFiles,
  onRepositories,
}: {
  disabled: boolean;
  mediaSupported: boolean;
  onFiles: (files: File[]) => void;
  onRepositories: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  return (
    <div ref={root} className="composer-add">
      <input
        ref={input}
        type="file"
        accept={MEDIA_ACCEPT}
        multiple
        tabIndex={-1}
        aria-label="Attach images or videos"
        className="sr-only"
        disabled={disabled || !mediaSupported}
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <button
        ref={trigger}
        type="button"
        aria-label="Add to prompt"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className={CONTROL_CLASS}
        onClick={() => setOpen(!open)}
      >
        <svg
          viewBox="0 0 24 24"
          className="size-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      {/*
        Mounted while closed so it can fade out as well as in. `inert` keeps the closed menu
        out of the tab order and the accessibility tree until the stylesheet's `display: none`
        lands at the end of the fade. Not `aria-hidden`: the menu often closes with one of its
        items still focused, and the browser refuses to hide a focused element that way.
      */}
      <div
        role="menu"
        aria-label="Add to prompt"
        inert={!open}
        data-open={open}
        className="composer-add-menu composer-surface nap-float"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setOpen(false);
            trigger.current?.focus();
          }
          if (event.key === "Tab") setOpen(false);
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
            );
            const index =
              document.activeElement instanceof HTMLButtonElement
                ? items.indexOf(document.activeElement)
                : -1;
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
          }
        }}
      >
        <button
          type="button"
          role="menuitem"
          disabled={!mediaSupported}
          title={mediaSupported ? undefined : "This model does not support media"}
          onClick={() => {
            setOpen(false);
            input.current?.click();
            trigger.current?.focus();
          }}
        >
          <span aria-hidden="true">▧</span> Upload media
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false);
            onRepositories();
          }}
        >
          <span aria-hidden="true">@</span> Repositories
        </button>
      </div>
    </div>
  );
}
