"use client";

import type { HumanComputerAction } from "@nap/shared/computer-access";
import { DESKTOP_HEIGHT, DESKTOP_WIDTH } from "@nap/shared/ports/sandbox-desktop";
import { type KeyboardEvent, useEffect, useEffectEvent, useRef, useState } from "react";
import styles from "./computer-input-surface.module.css";

type Point = [number, number];
type PendingClick = { coordinate: Point; timer: ReturnType<typeof setTimeout> };
const KEYS: Readonly<Record<string, string>> = {
  Escape: "Escape",
  Enter: "Return",
  Backspace: "BackSpace",
  Delete: "Delete",
  Tab: "Tab",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Home: "Home",
  End: "End",
  PageUp: "Prior",
  PageDown: "Next",
  Insert: "Insert",
  " ": "space",
  "+": "plus",
  "-": "minus",
  "=": "equal",
  ",": "comma",
  ".": "period",
  "/": "slash",
  "\\": "backslash",
  ";": "semicolon",
  "'": "apostrophe",
  "[": "bracketleft",
  "]": "bracketright",
  "`": "grave",
  "!": "exclam",
  "@": "at",
  "#": "numbersign",
  $: "dollar",
  "%": "percent",
  "^": "asciicircum",
  "&": "ampersand",
  "*": "asterisk",
  "(": "parenleft",
  ")": "parenright",
  _: "underscore",
  ":": "colon",
  '"': "quotedbl",
  "<": "less",
  ">": "greater",
  "?": "question",
  "{": "braceleft",
  "}": "braceright",
  "|": "bar",
  "~": "asciitilde",
};
function keysym(event: KeyboardEvent<HTMLTextAreaElement>): string | null {
  const key =
    KEYS[event.key] ??
    (/^[a-z0-9]$/i.test(event.key)
      ? event.key.toLowerCase()
      : /^F(?:[1-9]|1[0-2])$/.test(event.key)
        ? event.key
        : null);
  if (!key) return null;
  return [
    ...(event.ctrlKey ? ["ctrl"] : []),
    ...(event.altKey ? ["alt"] : []),
    ...(event.shiftKey ? ["shift"] : []),
    ...(event.metaKey ? ["super"] : []),
    key,
  ].join("+");
}

/** A transparent input layer over the live frame, inside its existing application role. */
export function ComputerInputSurface({
  driving,
  available,
  sourceKey,
  sendActions,
  takeControl,
  release,
}: {
  driving: boolean;
  available: boolean;
  /** Change with the session or live stream source to retire unfinished gestures. */
  sourceKey: string;
  sendActions: (actions: readonly HumanComputerAction[]) => Promise<boolean>;
  takeControl: () => Promise<boolean>;
  release: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const click = useRef<PendingClick | null>(null);
  const drag = useRef<{ pointer: number; start: Point; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const composing = useRef(false);
  const echo = useRef<string | null>(null);
  const echoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);
  const cancel = () => {
    if (click.current) clearTimeout(click.current.timer);
    click.current = null;
    drag.current = null;
    suppressClick.current = false;
    composing.current = false;
    echo.current = null;
    clearTimeout(echoTimer.current);
    if (input.current) input.current.value = "";
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: A source or permission change retires every local gesture and composition.
  useEffect(() => {
    cancel();
    setMessage(null);
    if (driving) input.current?.focus({ preventScroll: true });
    return cancel;
  }, [sourceKey, driving, available]);
  const point = (clientX: number, clientY: number): Point | null => {
    const bounds = input.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
    const scale = Math.min(bounds.width / DESKTOP_WIDTH, bounds.height / DESKTOP_HEIGHT);
    const x = (clientX - bounds.left - (bounds.width - DESKTOP_WIDTH * scale) / 2) / scale;
    const y = (clientY - bounds.top - (bounds.height - DESKTOP_HEIGHT * scale) / 2) / scale;
    return x >= 0 && x < DESKTOP_WIDTH && y >= 0 && y < DESKTOP_HEIGHT
      ? [Math.floor(x), Math.floor(y)]
      : null;
  };
  const flushClick = () => {
    const pending = click.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    click.current = null;
    if (driving) void sendActions([{ action: "left_click", coordinate: pending.coordinate }]);
  };
  const text = (value: string) => {
    if (!driving || !value) return;
    if (value.length > 32_000) {
      setMessage("Paste up to 32,000 characters at a time.");
      return;
    }
    const actions: HumanComputerAction[] = [];
    let chunk = "";
    for (const character of value) {
      if (chunk.length + character.length > 2000) {
        actions.push({ action: "type", text: chunk });
        chunk = "";
      }
      chunk += character;
      if (actions.length >= 16) break;
    }
    if (chunk) actions.push({ action: "type", text: chunk });
    if (actions.length > 16 || value.length > 32_000) {
      setMessage("Paste up to 32,000 characters at a time.");
      return;
    }
    flushClick();
    setMessage(null);
    // Enqueue the whole paste before another event can interleave. Each chunk
    // gets its own request deadline; the hook awaits acks and retires unsent work.
    for (const action of actions) void sendActions([action]);
  };
  const wheel = useEffectEvent((event: WheelEvent) => {
    const coordinate = point(event.clientX, event.clientY);
    if (!driving || !coordinate || (!event.deltaX && !event.deltaY)) return;
    event.preventDefault();
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const delta = horizontal ? event.deltaX : event.deltaY;
    flushClick();
    void sendActions([
      {
        action: "scroll",
        coordinate,
        scroll_direction: horizontal ? (delta > 0 ? "right" : "left") : delta > 0 ? "down" : "up",
        scroll_amount: Math.min(
          100,
          Math.max(1, Math.ceil(Math.abs(delta) / (event.deltaMode === 0 ? 100 : 1))),
        ),
      },
    ]);
  });
  useEffect(() => {
    const target = input.current;
    if (!target) return;
    // React delegates wheel listeners as passive, which cannot stop local scrolling.
    target.addEventListener("wheel", wheel, { passive: false });
    return () => target.removeEventListener("wheel", wheel);
  }, []);
  return (
    <div className={styles.surface} data-driving={driving || undefined}>
      <textarea
        ref={input}
        className={styles.input}
        aria-label="Type on the remote computer"
        aria-keyshortcuts="Shift+Escape"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={!available && !driving}
        onBlur={cancel}
        onContextMenu={(event) => {
          event.preventDefault();
          const coordinate = point(event.clientX, event.clientY);
          if (driving && coordinate) {
            flushClick();
            void sendActions([{ action: "right_click", coordinate }]);
          }
        }}
        onAuxClick={(event) => {
          event.preventDefault();
          const coordinate = point(event.clientX, event.clientY);
          if (driving && event.button === 1 && coordinate) {
            flushClick();
            void sendActions([{ action: "middle_click", coordinate }]);
          }
        }}
        onClick={(event) => {
          event.preventDefault();
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          const coordinate = point(event.clientX, event.clientY);
          if (!coordinate) return;
          if (!driving) {
            if (available) void takeControl();
            return;
          }
          if (event.detail > 2) return;
          if (event.detail === 2) {
            const pending = click.current;
            if (pending) clearTimeout(pending.timer);
            click.current = null;
            // Only a pending first click can be replaced by two remote clicks.
            // It may already have been sent, or consumed by acquiring control.
            void sendActions([{ action: pending ? "double_click" : "left_click", coordinate }]);
          } else {
            flushClick();
            click.current = { coordinate, timer: setTimeout(flushClick, 400) };
          }
        }}
        onPointerDown={(event) => {
          suppressClick.current = false;
          if (!driving || event.button !== 0 || drag.current) return;
          const start = point(event.clientX, event.clientY);
          if (!start) {
            suppressClick.current = true;
            return;
          }
          input.current?.focus({ preventScroll: true });
          drag.current = { pointer: event.pointerId, start, moved: false };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!driving) return;
          const coordinate = point(event.clientX, event.clientY);
          if (drag.current) {
            if (drag.current.pointer !== event.pointerId) return;
            if (
              coordinate &&
              Math.hypot(
                coordinate[0] - drag.current.start[0],
                coordinate[1] - drag.current.start[1],
              ) >= 4
            )
              drag.current.moved = true;
          } else if (coordinate && event.buttons === 0)
            void sendActions([{ action: "mouse_move", coordinate }]);
        }}
        onPointerUp={(event) => {
          const gesture = drag.current;
          if (!gesture || gesture.pointer !== event.pointerId) return;
          drag.current = null;
          const coordinate = point(event.clientX, event.clientY);
          if (gesture.moved) {
            suppressClick.current = true;
            if (driving && coordinate) {
              flushClick();
              void sendActions([
                { action: "left_click_drag", start_coordinate: gesture.start, coordinate },
              ]);
            }
          } else if (!coordinate) suppressClick.current = true;
          if (event.currentTarget.hasPointerCapture?.(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          cancel();
          suppressClick.current = true;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onKeyDown={(event) => {
          if (driving) event.stopPropagation();
          if (event.key === "Escape" && event.shiftKey) {
            event.stopPropagation();
            event.preventDefault();
            cancel();
            release();
            return;
          }
          if (!driving) {
            if (available && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              void takeControl();
            }
            return;
          }
          if (
            event.nativeEvent.isComposing ||
            composing.current ||
            event.key === "Process" ||
            event.keyCode === 229
          )
            return;
          echo.current = null;
          if (
            ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") ||
            (event.shiftKey && event.key === "Insert")
          )
            return;
          const special = event.key.length > 1 || event.ctrlKey || event.altKey || event.metaKey;
          if (!special) return;
          const chord = keysym(event);
          if (!chord) return;
          event.preventDefault();
          flushClick();
          void sendActions([{ action: "key", text: chord }]);
        }}
        onInput={(event) => {
          const value = event.currentTarget.value;
          if (composing.current || event.nativeEvent.isComposing) return;
          event.currentTarget.value = "";
          if (echo.current === value) {
            echo.current = null;
            return;
          }
          echo.current = null;
          text(value);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          if (!composing.current) {
            event.currentTarget.value = "";
            return;
          }
          composing.current = false;
          event.currentTarget.value = "";
          echo.current = event.data;
          clearTimeout(echoTimer.current);
          echoTimer.current = setTimeout(() => {
            echo.current = null;
          }, 0);
          text(event.data);
        }}
        onPaste={(event) => {
          event.preventDefault();
          if (!composing.current) text(event.clipboardData.getData("text/plain"));
          event.currentTarget.value = "";
        }}
        onCopy={(event) => event.preventDefault()}
        onCut={(event) => event.preventDefault()}
      />
      {!driving && available && <p className={styles.hint}>Click anywhere to drive the computer</p>}
      {message && (
        <p className={styles.message} role="status">
          {message}
        </p>
      )}
    </div>
  );
}
