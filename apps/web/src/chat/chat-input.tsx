"use client";

import type { MediaAttachment } from "@nap/shared/media";
import type { ModelChoice } from "@nap/shared/models-protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { appendDictation, useDictation } from "../dashboard/use-dictation.ts";
import { AttachmentButton, AttachmentTray, DictationButton } from "./composer-controls.tsx";
import { applyPick, menuRows, parseToken } from "./composer-menu.ts";
import { ModelPicker } from "./model-picker.tsx";
import { type DraftAttachment, useMediaAttachments } from "./use-media-attachments.ts";

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
  onSubmit: (message: string, attachments?: MediaAttachment[]) => void;
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
  const media = useMediaAttachments();
  const dictation = useDictation((spoken) =>
    setText((current) => appendDictation(current, spoken)),
  );
  const sentMedia = useRef<DraftAttachment[]>([]);
  /** Escape closes the menu without clearing the text, so it stays shut until the token changes. */
  const [dismissed, setDismissed] = useState("");
  const [active, setActive] = useState(0);
  /** The message currently in flight, kept only so a failure can hand it back. */
  const inFlight = useRef("");
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (error === undefined || inFlight.current === "") return;
    setText(inFlight.current);
    media.setAttachments(sentMedia.current);
    inFlight.current = "";
  }, [error, media.setAttachments]);

  useEffect(() => {
    if (running) dictation.stop();
  }, [running, dictation.stop]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: text changes the textarea scrollHeight.
  useLayoutEffect(() => {
    const field = box.current;
    if (!field) return;
    field.style.height = "0px";
    field.style.height = `${Math.min(Math.max(field.scrollHeight, MIN_HEIGHT), MAX_HEIGHT)}px`;
    field.style.overflowY = field.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [text]);

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
    const message =
      text.trim() || (media.attachments.length > 0 ? "Use these references for the app." : "");
    if (message === "" || running || media.processing) return;

    inFlight.current = message;
    setText("");
    dictation.stop();
    media.release(
      sentMedia.current.filter((sent) => !media.attachments.some((item) => item.id === sent.id)),
    );
    sentMedia.current = media.attachments;
    media.setAttachments([]);
    if (sentMedia.current.length === 0) onSubmit(message);
    else
      onSubmit(
        message,
        sentMedia.current.map((item) => item.media),
      );
  };

  const empty = text.trim() === "" && media.attachments.length === 0;

  return (
    <div className="chat-input mx-auto w-full max-w-[46rem] px-4 pt-2 pb-4">
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
            className="composer-menu nap-pop absolute inset-x-0 bottom-1 z-10 overflow-hidden rounded-xl p-1 shadow-raised"
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

      {[media.error, dictation.error].filter(Boolean).map((message) => (
        <p key={message} role="alert" className="pb-2 text-xs text-danger">
          {message}
        </p>
      ))}
      {media.processing && (
        <p role="status" className="pb-2 text-xs text-muted">
          Preparing attachments…
        </p>
      )}
      {dictation.listening && (
        <p role="status" className="pb-2 text-xs text-accent-ink">
          {dictation.interim || "Listening…"}
        </p>
      )}
      <fieldset
        aria-label="Message composer"
        className="workspace-composer relative"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (!running) void media.add(Array.from(event.dataTransfer.files));
        }}
      >
        <AttachmentTray
          attachments={media.attachments}
          disabled={running || media.processing}
          onRemove={media.remove}
        />
        <div className="px-4 pt-4 pb-2">
          <textarea
            ref={box}
            aria-label="Message"
            rows={1}
            value={text}
            disabled={running}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length && !running) {
                event.preventDefault();
                void media.add(files);
              }
            }}
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
            placeholder={running ? "Working…" : "Ask a follow-up…"}
            className="block min-h-12 w-full min-w-0 resize-none bg-transparent text-sm leading-relaxed text-ink outline-none placeholder:text-muted disabled:text-muted"
          />
        </div>
        <div className="composer-toolbar flex items-center justify-between gap-2 px-3 pb-3 sm:px-4 sm:pb-4">
          <div className="flex min-w-0 items-center gap-1">
            <AttachmentButton
              disabled={running || media.processing}
              onFiles={(files) => void media.add(files)}
            />
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
          <div className="flex shrink-0 items-center gap-1.5">
            <DictationButton dictation={dictation} disabled={running || media.processing} />
            {running ? (
              <button
                type="button"
                onClick={onCancel}
                aria-label="Stop"
                className="composer-stop grid size-8 place-items-center rounded-full bg-hover text-ink focus-visible:outline-accent"
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
                disabled={empty || media.processing}
                aria-label="Send"
                className="composer-send grid size-8 place-items-center rounded-full bg-accent text-white disabled:bg-hover disabled:text-muted focus-visible:outline-accent"
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
      </fieldset>
    </div>
  );
}
