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

import type { ModelChoice } from "@nap/shared/models-protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { applyPick, menuRows, parseToken } from "./composer-menu.ts";
import { ModelPicker } from "./model-picker.tsx";

/** Room to write without swallowing the transcript. Past this the field scrolls instead of growing. */
const MAX_HEIGHT = 132;
const MIN_HEIGHT = 28;

export function ChatInput({
  running,
  error,
  onSubmit,
  onCancel,
  files = [],
  models = [],
  model,
  onModelChange,
  onAddKey,
}: {
  running: boolean;
  error: string | undefined;
  onSubmit: (message: string) => void;
  onCancel: () => void;
  /**
   * What this deployment will run a turn on. Empty hides the control entirely — a deployment
   * with one model has no choice to offer, and a menu with a single row is furniture.
   */
  models?: readonly ModelChoice[];
  /** The chosen model. Absent means the server's default, which is what most turns run on. */
  model?: string | undefined;
  onModelChange?: ((model: string) => void) | undefined;
  /** Opening the key form, for a model this caller cannot reach. */
  onAddKey?: (() => void) | undefined;
  /**
   * The project's files, for `@`. Defaulted so the many render tests need not supply them —
   * and an empty list is the honest state before a sandbox exists, not a broken menu.
   */
  files?: readonly string[];
}) {
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  /** Escape closes the menu without clearing the text, so it stays shut until the token changes. */
  const [dismissed, setDismissed] = useState("");
  const [active, setActive] = useState(0);
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

    // Measure the controls themselves, rather than deriving their width from the field. In the
    // expanded layout the field spans the whole row, so `row - field` becomes zero; using that
    // number made a long prompt alternate forever between expanded and collapsed whenever a
    // model choice changed the picker width.
    const actions = Array.from(row.children).filter((child) => child !== field);
    const actionWidth = actions.reduce((total, action) => total + action.clientWidth, 0);
    const columnGap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
    const collapsedWidth = Math.max(0, row.clientWidth - actionWidth - columnGap * actions.length);
    const wraps = text.includes("\n") || measure.offsetWidth + 8 > collapsedWidth;
    if (wraps !== expanded) setExpanded(wraps);

    // Collapsed before measuring, or `scrollHeight` only ever reports the tallest it has been
    // — the field would grow with the text and then refuse to shrink back.
    field.style.height = "0px";
    const content = field.scrollHeight;
    field.style.height = `${Math.min(Math.max(content, MIN_HEIGHT), MAX_HEIGHT)}px`;
    field.style.overflowY = content > MAX_HEIGHT ? "auto" : "hidden";
  }, [text, expanded, model]);

  // Derived, never stored. A menu held in state would survive the text that opened it — so
  // deleting the `@` would leave the list up over a sentence that no longer has a token in it.
  const token = running ? undefined : parseToken(text);
  const rows = token === undefined ? [] : menuRows(token, files);
  const open = token !== undefined && rows.length > 0 && dismissed !== text;

  // Keyed to the token rather than reset by an effect: a new query is a new list, and an
  // index left over from the last one points at a row that has moved.
  const index = Math.min(active, Math.max(rows.length - 1, 0));

  const pick = (row: (typeof rows)[number]) => {
    if (token === undefined) return;
    setText(applyPick(text, token, row));
    setActive(0);
    box.current?.focus();
  };

  const send = () => {
    const message = text.trim();
    if (message === "" || running) return;

    inFlight.current = message;
    setText("");
    onSubmit(message);
  };

  // Hidden when there is no choice to make: a deployment with one allowed model has none, and
  // a menu with a single row is furniture that implies a decision nobody has.
  const picker =
    models.length > 1 ? (models.find((choice) => choice.id === model) ?? models[0]) : undefined;
  const sendColumn = picker === undefined ? "col-start-2" : "col-start-3";

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

      {open && (
        // Anchored to the composer and grown upward: a list that opened downward would fall
        // off the bottom of the pane, and one that pushed the composer down would move the
        // target out from under the cursor as it appeared.
        <div className="relative">
          <ul
            aria-label={token?.kind === "file" ? "Files" : "Commands"}
            className="nap-pop absolute inset-x-0 bottom-1 z-10 overflow-hidden rounded-[10px] bg-field p-1 shadow-raised"
            style={{ transformOrigin: "bottom center" }}
          >
            {rows.map((row, position) => (
              <li key={row.key}>
                <button
                  type="button"
                  // The mouse must not take focus from the field: blurring it closes the menu
                  // and the click lands on nothing.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(position)}
                  onClick={() => pick(row)}
                  aria-current={position === index}
                  className={`flex h-8 w-full items-center gap-2.5 rounded-[6px] px-2 text-left ${
                    position === index ? "bg-hover" : ""
                  }`}
                >
                  <span className="shrink-0 truncate font-medium text-[12.5px] text-ink">
                    {row.name}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
                    {row.detail}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
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
          className={`grid items-end gap-x-1 gap-y-1.5 ${
            picker === undefined
              ? "grid-cols-[minmax(0,1fr)_28px]"
              : "grid-cols-[minmax(0,1fr)_auto_28px]"
          }`}
        >
          <textarea
            ref={box}
            aria-label="Message"
            rows={1}
            value={text}
            disabled={running}
            onChange={(event) => {
              setText(event.target.value);
            }}
            onKeyDown={(event) => {
              // A composing IME owns Enter *and* the arrows — they drive the candidate window,
              // and taking any of them here posts a half-written word.
              if (event.nativeEvent.isComposing) return;

              if (open) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : rows.length - 1;
                  setActive((current) => (current + step) % rows.length);
                  return;
                }
                if (event.key === "Escape") {
                  // Remembered against the text that was showing, so it reopens the moment the
                  // token changes rather than staying shut for the rest of the sentence.
                  setDismissed(text);
                  return;
                }
                const row = rows[index];
                if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                  if (row === undefined) return;
                  // Enter belongs to the menu while it is open. Sending here would post the
                  // half-typed `@Coun` the user was in the middle of completing.
                  event.preventDefault();
                  pick(row);
                  return;
                }
              }

              if (event.key !== "Enter" || event.shiftKey) return;
              // Otherwise the newline is inserted as well as the message being sent.
              event.preventDefault();
              send();
            }}
            placeholder={running ? "Working…" : "Describe the app you want"}
            className={`min-h-7 w-full min-w-0 resize-none bg-transparent px-1 py-[5px] text-[13px] text-ink leading-[18px] outline-none [overflow-wrap:anywhere] placeholder:text-muted disabled:text-muted ${
              expanded ? "col-span-full col-start-1 row-start-1" : "col-start-1 row-start-1"
            }`}
          />

          {picker !== undefined && (
            <div className={expanded ? "col-start-2 row-start-2" : "col-start-2 row-start-1"}>
              <ModelPicker
                models={models}
                model={model}
                disabled={running}
                onChange={(choice) => onModelChange?.(choice)}
                onAddKey={onAddKey}
                onPick={() => box.current?.focus()}
                closeWhen={text}
              />
            </div>
          )}

          {running ? (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Stop"
              className={`flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-hover text-ink-2 transition-[background-color,color,transform] duration-150 hover:text-ink active:scale-[0.94] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
                expanded ? `${sendColumn} row-start-2` : `${sendColumn} row-start-1`
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
              } ${expanded ? `${sendColumn} row-start-2` : `${sendColumn} row-start-1`}`}
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
