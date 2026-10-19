"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PencilIcon, TrashIcon } from "../ui/icons.tsx";

type Action = { kind: "rename"; name: string } | { kind: "delete" };
const ITEM =
  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] text-ink-2 hover:bg-hover hover:text-ink focus-visible:outline-accent";

export function SessionActions({
  name,
  disabled = false,
  onRename,
  onClose,
  onDelete,
}: {
  name: string;
  disabled?: boolean;
  onRename?: ((name: string) => void) | undefined;
  onClose?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLFieldSetElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const [action, setAction] = useState<Action>();

  useEffect(() => {
    if (!position) return;
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        setPosition(undefined);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPosition(undefined);
        trigger.current?.focus();
      }
    };
    const scroll = () => setPosition(undefined);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onEscape);
    window.addEventListener("resize", scroll);
    window.addEventListener("scroll", scroll, true);
    menu.current?.querySelector("button")?.focus();
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onEscape);
      window.removeEventListener("resize", scroll);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [position]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (action && !element.open) {
      element.showModal();
      input.current?.select();
    }
    if (!action && element.open) element.close();
  }, [action]);

  const choose = (next: Action) => {
    setPosition(undefined);
    setAction(next);
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={`Session actions for ${name}`}
        aria-expanded={position !== undefined}
        disabled={disabled}
        onClick={() => {
          const rect = trigger.current?.getBoundingClientRect();
          if (position) setPosition(undefined);
          else if (rect)
            setPosition({
              top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 136)),
              left: Math.max(8, rect.right - 168),
            });
        }}
        className={`session-actions mr-1 grid size-7 shrink-0 place-items-center rounded-md text-muted transition-opacity hover:bg-hover hover:text-ink group-hover:opacity-100 focus-visible:opacity-100 ${position ? "opacity-100" : "opacity-0"}`}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="8" r="1" />
          <circle cx="8" cy="8" r="1" />
          <circle cx="13" cy="8" r="1" />
        </svg>
      </button>
      {position &&
        createPortal(
          <fieldset
            ref={menu}
            aria-label={`Actions for ${name}`}
            style={position}
            className="fixed z-50 w-[168px] rounded-xl border border-edge bg-field p-1 shadow-raised"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setPosition(undefined);
                trigger.current?.focus();
              } else if (event.key === "Tab") {
                const targets = Array.from(
                  event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])"),
                );
                if (targets.length === 0) return;
                const focused = document.activeElement;
                const index = focused instanceof HTMLElement ? targets.indexOf(focused) : -1;
                const next = (index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length;
                event.preventDefault();
                event.stopPropagation();
                targets[next]?.focus();
              }
            }}
          >
            {onRename && (
              <button
                type="button"
                className={ITEM}
                onClick={() => choose({ kind: "rename", name })}
              >
                <PencilIcon />
                Rename
              </button>
            )}
            {onClose && (
              <button
                type="button"
                className={ITEM}
                onClick={() => {
                  setPosition(undefined);
                  onClose();
                }}
              >
                Put away
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                className={`${ITEM} text-danger`}
                onClick={() => choose({ kind: "delete" })}
              >
                <TrashIcon />
                Delete
              </button>
            )}
          </fieldset>,
          document.body,
        )}
      <dialog
        ref={dialog}
        aria-label={action?.kind === "delete" ? "Delete session" : "Rename session"}
        closedby="any"
        onClose={() => {
          setAction(undefined);
          trigger.current?.focus();
        }}
        className="m-auto w-[calc(100%_-_32px)] max-w-sm rounded-2xl border border-edge bg-panel p-6 text-ink shadow-raised backdrop:bg-black/60"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (action?.kind === "rename") {
              if (!action.name.trim()) return;
              onRename?.(action.name.trim());
            } else if (action?.kind === "delete") onDelete?.();
            setAction(undefined);
          }}
        >
          <h2 className="mb-4 text-sm font-medium">
            {action?.kind === "delete" ? "Delete session?" : "Rename session"}
          </h2>
          {action?.kind === "rename" ? (
            <label className="flex flex-col gap-2 text-xs text-muted">
              Session name
              <input
                ref={input}
                maxLength={60}
                value={action.name}
                onChange={(event) => setAction({ kind: "rename", name: event.target.value })}
                className="rounded-lg border border-edge bg-field px-3 py-2.5 text-sm text-ink outline-none focus:border-accent"
              />
            </label>
          ) : (
            <p className="text-[13px] leading-relaxed text-muted">
              “{name}” and its files will be permanently deleted. This cannot be undone.
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAction(undefined)}
              className="rounded-lg px-3 py-2 text-xs text-muted hover:bg-hover hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={action?.kind === "rename" && !action.name.trim()}
              className={`rounded-lg px-3 py-2 text-xs font-medium text-white disabled:opacity-40 ${action?.kind === "delete" ? "bg-danger" : "bg-accent"}`}
            >
              {action?.kind === "delete" ? "Delete session" : "Save"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
