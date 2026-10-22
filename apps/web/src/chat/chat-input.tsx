"use client";

import type { MediaAttachment } from "@nap/shared/media";
import { MODEL_MEDIA_UNSUPPORTED, modelSupportsImages } from "@nap/shared/model-capabilities";
import type { ModelChoice } from "@nap/shared/models-protocol";
import { Paperclip } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { appendDictation, useDictation } from "../dashboard/use-dictation.ts";
import { type ComposerDraft, ComposerDraftStore } from "../projects/composer-draft.ts";
import { useDraftNavigation } from "../projects/use-draft-navigation.ts";
import { ComposerAddMenu } from "./composer-add-menu.tsx";
import { AttachmentTray, DictationButton } from "./composer-controls.tsx";
import { applyPick, menuRows, parseToken } from "./composer-menu.ts";
import type { FirstPrompt } from "./first-prompt.ts";
import { ModelPicker } from "./model-picker.tsx";
import { useComposerScroll } from "./use-composer-scroll.ts";
import { useFileDrop } from "./use-file-drop.ts";
import { type DraftAttachment, useMediaAttachments } from "./use-media-attachments.ts";

/** Room to write without swallowing the transcript. Past this the field scrolls instead of growing. */
const MAX_HEIGHT = 132;
const MIN_HEIGHT = 28;

export function ChatInput({
  draftIdentity,
  visible = true,
  running,
  queueing = false,
  queued,
  contextControl,
  timeline,
  error,
  firstPrompt,
  onSubmit,
  onCancel,
  files = [],
  models = [],
  model,
  onModelChange,
  onAddKey,
  dropZone,
}: {
  draftIdentity?: { ownerId: string; projectId: string } | undefined;
  /**
   * Where a dropped file is taken from: the pane's whole chat stage, which is where the overlay
   * saying so is drawn. Absent, the composer itself is the target, with only its ring to show it.
   */
  dropZone?: HTMLElement | null | undefined;
  visible?: boolean;
  running: boolean;
  queueing?: boolean;
  queued?: Pick<FirstPrompt, "text" | "attachments"> | undefined;
  contextControl?: ReactNode;
  timeline?: RefObject<HTMLElement | null> | undefined;
  error: string | undefined;
  firstPrompt?: FirstPrompt | undefined;
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
  const [sourceOpen, setSourceOpen] = useState(false);
  const [draftError, setDraftError] = useState<string>();
  const [draftReady, setDraftReady] = useState(!draftIdentity);
  const latestDraft = useRef<ComposerDraft | undefined>(undefined);
  const draftStore = useRef(new ComposerDraftStore());
  const draftOwner = draftIdentity?.ownerId;
  const draftProject = draftIdentity?.projectId;
  const restoreModel = useRef(onModelChange);
  restoreModel.current = onModelChange;
  useEffect(() => {
    if (!draftOwner || !draftProject) return;
    let cancelled = false;
    setDraftReady(false);
    void draftStore.current
      .load(draftOwner, draftProject)
      .then((saved) => {
        if (cancelled) return;
        if (saved) {
          setText(saved.text);
          media.setAttachments(
            saved.attachments.map((item) => ({
              id: crypto.randomUUID(),
              previewUrl: undefined,
              media: item,
            })),
          );
          if (saved.model) restoreModel.current?.(saved.model);
        }
        setDraftReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          setDraftError("Could not restore the draft. Browser storage is unavailable.");
          setDraftReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [draftOwner, draftProject, media.setAttachments]);
  if (draftReady && draftOwner && draftProject)
    latestDraft.current = {
      id: draftProject,
      ownerId: draftOwner,
      operationId: draftProject,
      text,
      model,
      source: null,
      attachments: media.attachments.map((item) => item.media),
      expiresAt: Date.now() + 7 * 86400_000,
    };
  // biome-ignore lint/correctness/useExhaustiveDependencies: edits restart the debounce; the callback reads the latest complete draft.
  useEffect(() => {
    const save = () => {
      const value = latestDraft.current;
      if (value)
        void draftStore.current
          .save(value)
          .catch(() =>
            setDraftError(
              "Could not save this draft. Keep the session open and free browser storage.",
            ),
          );
    };
    const timer = setTimeout(save, 250);
    return () => clearTimeout(timer);
  }, [text, model, media.attachments, draftReady]);
  useEffect(
    () => () => {
      const value = latestDraft.current;
      if (value) void draftStore.current.save(value).catch(() => {});
    },
    [],
  );
  useDraftNavigation(
    draftReady && draftOwner && draftProject
      ? async () => {
          const value = latestDraft.current;
          if (value) await draftStore.current.save(value);
        }
      : undefined,
    () =>
      setDraftError("Could not save this draft. Keep the session open and free browser storage."),
  );
  const drop = useFileDrop({
    zone: dropZone,
    enabled: !running && draftReady,
    onFiles: (dropped) => void media.add(dropped),
  });
  const images = modelSupportsImages(model);
  const incompatibleMedia = media.attachments.length > 0 && !images;
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
  const root = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLFieldSetElement>(null);
  const [multiline, setMultiline] = useState(false);
  const token = running && !queueing ? undefined : parseToken(text);
  const rows = token === undefined ? [] : menuRows(token, files);
  const open = token !== undefined && rows.length > 0 && dismissed !== text;
  const scroll = useComposerScroll({
    timeline,
    composer: root,
    eligible:
      visible &&
      !multiline &&
      !open &&
      !sourceOpen &&
      error === undefined &&
      draftError === undefined &&
      queued === undefined &&
      media.attachments.length === 0 &&
      !media.processing &&
      media.error === undefined &&
      !dictation.listening &&
      dictation.error === undefined,
  });

  useEffect(() => {
    if (
      visible &&
      !running &&
      !scroll.restingRef.current &&
      document.activeElement === document.body
    ) {
      box.current?.focus({ preventScroll: true });
    }
  }, [running, visible, scroll.restingRef]);

  useEffect(() => {
    if (error === undefined) return;
    if (inFlight.current !== "") {
      setText(inFlight.current);
      media.setAttachments(sentMedia.current);
      inFlight.current = "";
    } else if (firstPrompt !== undefined) {
      setText(firstPrompt.text);
      media.setAttachments(
        (firstPrompt.attachments ?? []).map((attachment) => ({
          id: crypto.randomUUID(),
          previewUrl: undefined,
          media: attachment,
        })),
      );
    }
  }, [error, firstPrompt, media.setAttachments]);

  useEffect(() => {
    if (running || !visible) dictation.stop();
  }, [running, visible, dictation.stop]);
  useLayoutEffect(() => {
    const field = box.current;
    if (!field) return;
    const measure = () => {
      field.style.minHeight = "0px";
      field.style.height = "0px";
      const lineHeight = Number.parseFloat(getComputedStyle(field).lineHeight) || 24;
      setMultiline(text.includes("\n") || field.scrollHeight > lineHeight * 1.5);
      field.style.minHeight = "";
      field.style.height = scroll.resting
        ? "32px"
        : `${Math.min(Math.max(field.scrollHeight, MIN_HEIGHT), MAX_HEIGHT)}px`;
      field.style.overflowY = field.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
      if (!scroll.resting && surface.current !== null) {
        surface.current.style.setProperty(
          "--composer-expanded-height",
          `${surface.current.getBoundingClientRect().height}px`,
        );
      }
    };
    measure();
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (field.clientWidth === width) return;
      width = field.clientWidth;
      measure();
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [text, scroll.resting]);

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
    if (
      !draftReady ||
      message === "" ||
      (running && !queueing) ||
      media.processing ||
      incompatibleMedia
    )
      return;

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
    <div ref={root} className="chat-input relative mx-auto w-full max-w-[46rem] px-4 pt-2 pb-4">
      {scroll.away && (
        <div
          className="absolute inset-x-0 -top-9 flex justify-center"
          style={{ pointerEvents: "none" }}
        >
          <button
            type="button"
            onClick={scroll.scrollToEnd}
            className="composer-surface pointer-events-auto flex h-7 items-center gap-1 rounded-full px-2.5 text-xs text-ink-2 shadow-raised hover:text-ink focus-visible:outline-accent"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              className="size-3"
            >
              <path d="m4 6 4 4 4-4" />
            </svg>
            Scroll to end
          </button>
        </div>
      )}
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
            className="composer-surface nap-float absolute inset-x-0 bottom-1 z-10 overflow-hidden rounded-[10px] p-1"
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

      {[
        draftError,
        media.error,
        dictation.error,
        incompatibleMedia ? MODEL_MEDIA_UNSUPPORTED : undefined,
      ]
        .filter(Boolean)
        .map((message) => (
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
      {queued !== undefined && <QueuedMessage {...queued} />}
      <fieldset
        ref={surface}
        aria-label="Message composer"
        data-resting={scroll.resting}
        // A ring rather than a tint: the glass behind the composer is a layer of its own, and a
        // background or an inset shadow on this element would be painted underneath it.
        className={`workspace-composer relative ${
          drop.dragging ? "outline-1 outline-accent/70 -outline-offset-1" : ""
        }`}
        onPointerDownCapture={(event) => {
          if (!(event.target instanceof Element)) return;
          if (event.target.closest('button, input, select, summary, a, [role="button"]')) return;
          scroll.expand();
          if (scroll.resting && event.target !== box.current) {
            event.preventDefault();
            box.current?.focus({ preventScroll: true });
          }
        }}
        {...(dropZone === undefined || dropZone === null ? drop.reactHandlers : {})}
      >
        {sourceOpen && (
          <div className="p-4 text-xs text-muted">
            <p>This session keeps its current codebase.</p>
            <a
              href="/dashboard?repositories=1"
              className="mt-2 inline-block underline underline-offset-4"
            >
              Start new session from GitHub
            </a>
            <button
              type="button"
              aria-label="Close repository details"
              className="ml-3"
              onClick={() => setSourceOpen(false)}
            >
              ×
            </button>
          </div>
        )}
        <AttachmentTray
          attachments={media.attachments}
          disabled={running || media.processing}
          onRemove={media.remove}
        />
        <div className="composer-prompt px-4 pt-4 pb-2">
          <textarea
            ref={box}
            aria-label="Message"
            rows={1}
            onPointerDown={scroll.expand}
            onFocus={scroll.focusEditor}
            value={text}
            disabled={!draftReady || (running && !queueing)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length && !running) {
                event.preventDefault();
                void media.add(files);
              }
            }}
            onChange={(event) => {
              scroll.expand();
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
            placeholder={
              queueing
                ? "Queue a message after compaction…"
                : running
                  ? "Working…"
                  : "Ask a follow-up…"
            }
            className="block min-h-12 w-full min-w-0 resize-none bg-transparent text-sm leading-relaxed text-ink outline-none placeholder:text-muted disabled:text-muted"
          />
        </div>
        <div className="composer-toolbar flex items-center justify-between gap-2 px-3 pb-3 sm:px-4 sm:pb-4">
          <div className="composer-model-controls flex min-w-0 items-center gap-1">
            <ModelPicker
              models={models}
              model={model}
              disabled={!draftReady || (running && !queueing)}
              onChange={(choice) => onModelChange?.(choice)}
              onAddKey={onAddKey}
              onPick={() => box.current?.focus()}
              closeWhen={`${visible}:${text}`}
            />
            <DictationButton dictation={dictation} disabled={running || media.processing} />
          </div>
          <div className="composer-primary-actions flex shrink-0 items-center gap-1.5">
            <ComposerAddMenu
              disabled={running || media.processing || !draftReady}
              mediaSupported={images}
              onFiles={(files) => void media.add(files)}
              onRepositories={() => setSourceOpen(!sourceOpen)}
            />
            {contextControl}
            {running && (
              <button
                type="button"
                onClick={onCancel}
                aria-label="Stop"
                className="composer-stop flex size-8 shrink-0 items-center justify-center rounded-full bg-danger/90 text-white transition-colors duration-150 hover:bg-danger focus-visible:outline-accent [&_svg]:pointer-events-none"
              >
                {/* A filled square: the universal stop mark, and legible at 12px where a word is not. */}
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <rect x="2" y="2" width="8" height="8" rx="1.5" />
                </svg>
              </button>
            )}
            {(!running || (queueing && !empty)) && (
              <button
                type="button"
                onClick={send}
                disabled={!draftReady || empty || media.processing || incompatibleMedia}
                aria-label={queueing ? "Queue message" : "Send"}
                className="composer-send relative isolate flex size-9 items-center justify-center overflow-hidden rounded-full bg-accent text-white transition-all duration-150 enabled:cursor-pointer disabled:pointer-events-none disabled:opacity-64 sm:size-8 focus-visible:outline-accent [&_svg]:pointer-events-none"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path
                    d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      </fieldset>
      {drop.dragging &&
        dropZone !== undefined &&
        dropZone !== null &&
        createPortal(<DropOverlay />, dropZone)}
    </div>
  );
}

/**
 * The whole chat saying it will take the file, the way T3 Code's does (MIT — see
 * `apps/web/THIRD_PARTY_NOTICES.md`): a dashed frame inset from the stage and one pill in the
 * middle. In the accent rather than T3's primary, and it takes no pointer events, so the drop
 * lands on the stage beneath it.
 */
function DropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-accent/60 border-dashed bg-accent/[0.035]">
      <div
        role="status"
        className="flex items-center gap-2 rounded-full border border-accent/25 bg-panel/95 px-4 py-2.5 font-medium text-ink text-sm shadow-raised"
      >
        <Paperclip aria-hidden="true" className="size-4 text-accent-ink" />
        Drop files to attach
      </div>
    </div>
  );
}

function QueuedMessage({ text, attachments }: Pick<FirstPrompt, "text" | "attachments">) {
  return (
    <details
      open
      aria-label="Queued messages"
      className="composer-queue group mx-[22px] -mb-[17px] rounded-t-2xl border border-b-0 px-1 pt-1 pb-[21px] text-xs text-muted"
    >
      <summary
        aria-label="Queued messages, 1"
        className="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-t-xl px-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent [&::-webkit-details-marker]:hidden"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-3.5 shrink-0"
        >
          <path d="M10 6h10M10 12h10M10 18h10M4 5h1v4M4 9h2M3.5 15a1.5 1.5 0 0 1 3 0c0 1-3 2-3 3h3" />
        </svg>
        <span className="flex-1">Queued</span>
        <span className="tabular-nums">1</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="ml-2 size-3.5 -rotate-90 group-open:rotate-0"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="nap-scroll max-h-32 overflow-y-auto px-2 pb-1">
        <p role="status" className="sr-only">
          Queued after compaction
        </p>
        <ol aria-label="Queued prompts">
          <li className="flex min-h-7 min-w-0 items-start gap-2 pl-[22px] text-ink-2">
            {attachments?.map((attachment) => {
              const frame = attachment.frames[0];
              return frame === undefined ? null : (
                // biome-ignore lint/performance/noImgElement: prepared references already contain inline JPEG data.
                <img
                  key={attachment.name}
                  src={`data:${frame.mediaType};base64,${frame.data}`}
                  alt={attachment.name}
                  title={attachment.name}
                  className="mt-0.5 size-5 shrink-0 rounded border border-edge object-cover"
                />
              );
            })}
            <span className="min-w-0 whitespace-pre-wrap break-words leading-6 [overflow-wrap:anywhere]">
              {text}
            </span>
          </li>
        </ol>
      </div>
    </details>
  );
}
