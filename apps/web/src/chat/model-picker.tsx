"use client";

/** The deployment-backed model choice used by both prompt composers. */

import type { ModelChoice } from "@nap/shared/models-protocol";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Ties a locked row to the words explaining why, for anyone not reading with their eyes. */
const LOCKED_HINT_ID = "model-locked";

export function ModelPicker({
  models,
  model,
  disabled = false,
  onChange,
  onPick,
  onAddKey,
  closeWhen,
}: {
  models: readonly ModelChoice[];
  /** The server fallback is supplied by the caller when no explicit choice has been made. */
  model: string | undefined;
  disabled?: boolean;
  onChange: (model: string) => void;
  /** Returns focus to the composer after a choice, where one was supplied. */
  onPick?: (() => void) | undefined;
  /**
   * Opening the place where a key is pasted, for a model this caller cannot reach.
   *
   * Absent leaves the locked entries inert but still visible. They are *shown* either way and
   * never filtered out: a menu that silently omits Opus makes the product look smaller than it
   * is, and gives nobody a way to find out that one key is all it takes.
   */
  onAddKey?: (() => void) | undefined;
  /** A changing composer token closes the menu before a competing suggestion menu opens. */
  closeWhen?: unknown;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const [position, setPosition] = useState<{ bottom: number; right: number } | undefined>(
    undefined,
  );
  // The tick falls back to the first *reachable* model rather than the first listed one, so a
  // free caller never sees a locked model named as the one their message will run on.
  const selected =
    models.length > 1
      ? (models.find((choice) => choice.id === model) ??
        models.find((choice) => choice.available) ??
        models[0])
      : undefined;

  useEffect(() => {
    if (!open) return;

    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (root.current?.contains(target) !== true && menu.current?.contains(target) !== true) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [open]);

  useEffect(() => {
    // Reading the token is intentional: a new value means the composer is now serving a
    // different interaction, so this menu must yield to it.
    if (closeWhen !== undefined) setOpen(false);
  }, [closeWhen]);

  if (selected === undefined) return null;

  return (
    <div ref={root} className="relative">
      {open &&
        position !== undefined &&
        createPortal(
          <ul
            ref={menu}
            aria-label="Model"
            className="nap-pop fixed z-50 w-52 overflow-hidden rounded-[10px] bg-field p-1 shadow-raised"
            style={{ ...position, transformOrigin: "bottom right" }}
          >
            {models.map((choice) => (
              <li key={choice.id}>
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    // A locked entry is a doorway rather than a dead end: pressing it opens
                    // the key form, which is the only thing that would make it selectable.
                    if (!choice.available) {
                      setOpen(false);
                      onAddKey?.();
                      return;
                    }
                    onChange(choice.id);
                    setOpen(false);
                    onPick?.();
                  }}
                  aria-current={choice.id === selected.id}
                  // Not `disabled`: a disabled control is unreachable by keyboard and
                  // unannounced by a screen reader, so the one explanation of why this model
                  // is out of reach would be visible only to people using a mouse and eyes.
                  aria-describedby={choice.available ? undefined : `${LOCKED_HINT_ID}-${choice.id}`}
                  className={`flex h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left hover:bg-hover ${
                    choice.id === selected.id ? "bg-hover" : ""
                  }`}
                >
                  <span
                    className={`min-w-0 flex-1 truncate font-medium text-[12.5px] ${
                      choice.available ? "text-ink" : "text-muted"
                    }`}
                  >
                    {choice.label}
                  </span>
                  {choice.free && (
                    <span className="shrink-0 rounded-[4px] bg-hover px-1 py-px font-medium text-[10px] text-muted uppercase tracking-wide">
                      Free
                    </span>
                  )}
                  {!choice.available && (
                    <span
                      id={`${LOCKED_HINT_ID}-${choice.id}`}
                      className="shrink-0 text-[11px] text-muted"
                    >
                      needs your key
                    </span>
                  )}
                  {choice.available && choice.id === selected.id && (
                    <span className="shrink-0 text-[11px] text-muted">on</span>
                  )}
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}

      <button
        type="button"
        aria-label="Model"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          const bounds = root.current?.getBoundingClientRect();
          if (bounds === undefined) return;
          setPosition({
            bottom: window.innerHeight - bounds.top + 4,
            right: window.innerWidth - bounds.right,
          });
          setOpen(true);
        }}
        className="flex h-7 shrink-0 items-center gap-1 rounded-[8px] px-1.5 font-medium text-[12px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:text-muted"
      >
        {selected.label}
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
    </div>
  );
}
