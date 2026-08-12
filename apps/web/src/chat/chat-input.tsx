"use client";

/**
 * Where the user says what they want.
 *
 * **One action, never two.** While a turn is running the box is disabled and the button says
 * Stop rather than Send. A Send sitting beside a Cancel invites someone to queue a message
 * the server would refuse, and the runtime runs one turn per session — so the interface
 * should not imply otherwise.
 *
 * Enter sends and Shift+Enter makes a newline, which is the convention every chat interface
 * has settled on. It matters more here than usual: a prompt is often several sentences, and
 * losing one to a stray Enter is the kind of thing people stop trusting an input over.
 *
 * The text is cleared on send and **put back if the send failed**, because the hook rolls the
 * optimistic message back and the words have to survive somewhere the user will look for
 * them.
 *
 * **The box grows with what is typed, and the controls move when it does.** A prompt is
 * usually a paragraph, and a fixed two-row field either wastes the room or hides the words.
 * The field measures the text against the space left beside the controls; once it would wrap,
 * it takes the whole width and the controls drop to a row of their own. Both the measurement
 * and the auto-height run in a layout effect, so the change is committed in the frame the
 * character arrives in and nothing is ever seen at the wrong size.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Room to write without swallowing the transcript. Past this the field scrolls instead of growing. */
const MAX_HEIGHT = 132;
const MIN_HEIGHT = 28;

export function ChatInput({
  running,
  error,
  onSubmit,
  onCancel,
}: {
  running: boolean;
  error: string | undefined;
  onSubmit: (message: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  /** The message currently in flight, kept only so a failure can hand it back. */
  const inFlight = useRef("");
  const box = useRef<HTMLTextAreaElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  /** An unpainted copy of the text at the field's own metrics, for measuring one line of it. */
  const ruler = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (error === undefined || inFlight.current === "") return;
    setText(inFlight.current);
    inFlight.current = "";
  }, [error]);

  useLayoutEffect(() => {
    const field = box.current;
    const row = controls.current;
    const measure = ruler.current;
    if (field === null || row === null || measure === null) return;

    // What the controls beside the field take up, measured rather than counted — adding a
    // control would otherwise move the wrap point silently and leave the field under it.
    const beside = row.clientWidth - field.clientWidth;
    const wraps = text.includes("\n") || measure.offsetWidth + 8 > row.clientWidth - beside;
    if (wraps !== expanded) setExpanded(wraps);

    // Collapsed before measuring, or `scrollHeight` only ever reports the tallest it has been
    // — the field would grow with the text and then refuse to shrink back.
    field.style.height = "0px";
    const content = field.scrollHeight;
    field.style.height = `${Math.min(Math.max(content, MIN_HEIGHT), MAX_HEIGHT)}px`;
    field.style.overflowY = content > MAX_HEIGHT ? "auto" : "hidden";
  }, [text, expanded]);

  const send = () => {
    const message = text.trim();
    if (message === "" || running) return;

    inFlight.current = message;
    setText("");
    onSubmit(message);
  };

  const empty = text.trim() === "";

  return (
    <div className="shrink-0 p-3">
      {error !== undefined && (
        // `alert` so it is announced: the message the user just sent has vanished from the
        // screen, and nothing else on the page explains why.
        <p role="alert" className="pb-2 text-danger text-xs">
          {error}
        </p>
      )}

      <div className="relative isolate flex flex-col gap-1.5 overflow-hidden rounded-[14px] border border-edge bg-panel p-1.5 shadow-card transition-colors duration-150 focus-within:border-line-strong">
        {/*
          Never painted and never read aloud — it exists only to be measured. The field itself
          cannot answer "would this wrap?" without being resized first, which is a frame of
          visible jitter; a span at the same metrics answers before anything is committed.
        */}
        <span
          ref={ruler}
          aria-hidden="true"
          className="pointer-events-none invisible absolute whitespace-pre text-[13px] leading-[18px]"
        >
          {text}
        </span>

        <div
          ref={controls}
          className="grid grid-cols-[minmax(0,1fr)_28px] items-end gap-x-1 gap-y-1.5"
        >
          <textarea
            ref={box}
            aria-label="Message"
            rows={1}
            value={text}
            disabled={running}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              // A composing IME uses Enter to accept a candidate; sending on it would post a
              // half-written word and swallow the keystroke meant to finish it.
              if (event.nativeEvent.isComposing) return;
              // Otherwise the newline is inserted as well as the message being sent.
              event.preventDefault();
              send();
            }}
            placeholder={running ? "Working…" : "Describe the app you want"}
            className={`min-h-7 w-full min-w-0 resize-none bg-transparent px-1 py-[5px] text-[13px] text-ink leading-[18px] outline-none [overflow-wrap:anywhere] placeholder:text-muted disabled:text-muted ${
              expanded ? "col-span-full col-start-1 row-start-1" : "col-start-1 row-start-1"
            }`}
          />

          {running ? (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Stop"
              className={`flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-hover text-ink-2 transition-[background-color,color,transform] duration-150 hover:text-ink active:scale-[0.94] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
                expanded ? "col-start-2 row-start-2" : "col-start-2 row-start-1"
              }`}
            >
              {/* A filled square: the universal stop mark, and legible at 15px where a word is not. */}
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <rect x="7" y="7" width="10" height="10" rx="1.5" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={empty}
              aria-label="Send"
              className={`flex size-7 shrink-0 items-center justify-center rounded-[8px] transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
                empty ? "bg-line-strong text-ink-2" : "bg-ink text-surface"
              } ${expanded ? "col-start-2 row-start-2" : "col-start-2 row-start-1"}`}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
