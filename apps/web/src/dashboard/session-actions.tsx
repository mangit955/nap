"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PencilIcon, TrashIcon } from "../ui/icons.tsx";

type Action =
  | { kind: "rename"; name: string }
  | { kind: "delete" }
  | { kind: "snooze"; until: string };
const ITEM =
  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] text-ink-2 hover:bg-hover hover:text-ink focus-visible:outline-accent";

export function SessionActions({
  name,
  disabled = false,
  onRename,
  onClose,
  onDelete,
  extraActions = [],
  onSnooze,
}: {
  name: string;
  extraActions?: { label: string; disabled?: boolean; onSelect: () => void }[];
  onSnooze?: ((until: string) => void) | undefined;
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
    const scroll = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      setPosition(undefined);
    };
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
              top: Math.max(
                8,
                Math.min(
                  rect.bottom + 4,
                  window.innerHeight - Math.min(560, window.innerHeight - 16),
                ),
              ),
              left: Math.max(8, Math.min(rect.right - 224, window.innerWidth - 232)),
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
            className="fixed z-50 w-56 max-h-[calc(100dvh-16px)] overflow-y-auto nap-scroll-hidden rounded-xl border border-edge bg-field p-1 shadow-raised"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setPosition(undefined);
                trigger.current?.focus();
              } else if (["Tab", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                const targets = Array.from(
                  event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])"),
                );
                if (targets.length === 0) return;
                const focused = document.activeElement;
                const index = focused instanceof HTMLElement ? targets.indexOf(focused) : -1;
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? targets.length - 1
                      : (index +
                          (event.shiftKey || event.key === "ArrowUp" ? -1 : 1) +
                          targets.length) %
                        targets.length;
                event.preventDefault();
                event.stopPropagation();
                targets[next]?.focus();
              }
            }}
          >
            {extraActions.map((item) => (
              <button
                key={item.label}
                type="button"
                className={ITEM}
                disabled={item.disabled}
                onClick={() => {
                  setPosition(undefined);
                  item.onSelect();
                  trigger.current?.focus();
                }}
              >
                {item.label}
              </button>
            ))}
            {onSnooze && (
              <>
                <button
                  type="button"
                  className={ITEM}
                  onClick={() => {
                    setPosition(undefined);
                    onSnooze(new Date(Date.now() + 3600000).toISOString());
                    trigger.current?.focus();
                  }}
                >
                  Snooze for 1 hour
                </button>
                <button
                  type="button"
                  className={ITEM}
                  onClick={() => {
                    setPosition(undefined);
                    onSnooze(new Date(Date.now() + 86400000).toISOString());
                    trigger.current?.focus();
                  }}
                >
                  Snooze for 1 day
                </button>
                <button
                  type="button"
                  className={ITEM}
                  onClick={() => choose({ kind: "snooze", until: "" })}
                >
                  Snooze until…
                </button>
              </>
            )}
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
                Put away workspace
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                className={`${ITEM} text-danger`}
                onClick={() => choose({ kind: "delete" })}
              >
                <TrashIcon />
                Delete project
              </button>
            )}
          </fieldset>,
          document.body,
        )}
      <dialog
        ref={dialog}
        aria-label={
          action?.kind === "delete"
            ? "Delete session"
            : action?.kind === "snooze"
              ? "Snooze session"
              : "Rename session"
        }
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
            else if (action?.kind === "snooze") {
              const time = Date.parse(action.until);
              if (!Number.isFinite(time) || time <= Date.now()) return;
              onSnooze?.(new Date(time).toISOString());
            }
            setAction(undefined);
          }}
        >
          <h2 className="mb-4 text-sm font-medium">
            {action?.kind === "delete"
              ? "Delete project?"
              : action?.kind === "snooze"
                ? "Snooze session"
                : "Rename session"}
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
          ) : action?.kind === "snooze" ? (
            <label className="flex flex-col gap-2 text-xs text-muted">
              Wake time
              <input
                type="datetime-local"
                required
                value={action.until}
                onChange={(event) => setAction({ kind: "snooze", until: event.target.value })}
                className="rounded-lg border border-edge bg-field px-3 py-2"
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
