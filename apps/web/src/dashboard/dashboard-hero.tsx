"use client";

import type { MediaAttachment } from "@nap/shared/media";
import type { ModelChoice } from "@nap/shared/models-protocol";
import { useEffect, useRef } from "react";
import { AttachmentButton, AttachmentTray, DictationButton } from "../chat/composer-controls.tsx";
import { ModelPicker } from "../chat/model-picker.tsx";
import { useMediaAttachments } from "../chat/use-media-attachments.ts";

import { appendDictation, useDictation } from "./use-dictation.ts";

export function DashboardHero({
  value,
  busy = false,
  error,
  models = [],
  modelsLoading = false,
  model,
  onModelChange,
  onAddKey,
  onChange,
  onSubmit,
}: {
  value: string;
  busy?: boolean;
  error?: string | undefined;
  models?: readonly ModelChoice[];
  modelsLoading?: boolean;
  model?: string | undefined;
  onModelChange?: ((model: string) => void) | undefined;
  onAddKey?: (() => void) | undefined;
  onChange: (value: string) => void;
  onSubmit: (message: string, attachments?: MediaAttachment[]) => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const media = useMediaAttachments();
  const dictation = useDictation((spoken) => onChange(appendDictation(value, spoken)));
  const disabled = busy || media.processing;
  useEffect(() => {
    if (busy) dictation.stop();
  }, [busy, dictation.stop]);
  const send = () => {
    const message =
      value.trim() || (media.attachments.length > 0 ? "Build an app using these references." : "");
    if (message === "" || disabled) return;
    dictation.stop();
    if (media.attachments.length === 0) onSubmit(message);
    else
      onSubmit(
        message,
        media.attachments.map((item) => item.media),
      );
  };

  return (
    <div className="dashboard-home">
      <div className="dashboard-prompt">
        <div className="mb-5 flex items-center justify-between px-2">
          <h1 className="flex items-center gap-2.5 text-[28px] font-semibold tracking-[-1px] text-ink">
            <span aria-hidden="true" className="workspace-monogram size-8 text-xl">
              n
            </span>
            nap
          </h1>
          <span className="rounded-full border border-edge px-3 py-1 text-[11px] text-muted">
            New session
          </span>
        </div>
        <fieldset
          aria-label="New session composer"
          className="workspace-composer"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (!disabled) void media.add(Array.from(event.dataTransfer.files));
          }}
        >
          <AttachmentTray
            attachments={media.attachments}
            disabled={disabled}
            onRemove={media.remove}
          />
          <textarea
            ref={box}
            aria-label="Describe the app you want"
            rows={4}
            value={value}
            disabled={busy}
            onChange={(event) => onChange(event.target.value)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length && !disabled) {
                event.preventDefault();
                void media.add(files);
              }
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              send();
            }}
            placeholder="Ask nap to build an app, fix a bug, or explore an idea…"
            className="block h-[116px] min-h-[116px] w-full resize-none bg-transparent px-5 pt-5 pb-3 text-[15px] leading-relaxed text-ink outline-none placeholder:text-muted disabled:text-muted"
          />
          <div className="flex items-center justify-between gap-2 px-3.5 pb-3.5 pt-1">
            <div className="flex min-w-0 items-center gap-1">
              <AttachmentButton disabled={disabled} onFiles={(files) => void media.add(files)} />
              <ModelPicker
                models={models}
                model={model}
                disabled={disabled}
                loading={modelsLoading}
                onChange={(choice) => onModelChange?.(choice)}
                onAddKey={onAddKey}
                onPick={() => box.current?.focus()}
              />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <DictationButton dictation={dictation} disabled={disabled} />
              <button
                type="button"
                aria-label="Send"
                onClick={send}
                disabled={disabled || (value.trim() === "" && media.attachments.length === 0)}
                className="composer-send grid size-8 place-items-center rounded-full bg-accent text-white transition-colors hover:bg-accent/90 disabled:bg-hover disabled:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="size-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 19V5m-7 7 7-7 7 7" />
                </svg>
              </button>
            </div>
          </div>
        </fieldset>
        {media.processing && (
          <p role="status" className="mt-3 text-xs text-muted">
            Preparing attachments…
          </p>
        )}
        {dictation.listening && (
          <p role="status" className="mt-3 text-xs text-accent-ink">
            {dictation.interim || "Listening…"}
          </p>
        )}
        {[media.error, dictation.error, error].filter(Boolean).map((message) => (
          <p key={message} role="alert" className="mt-3 text-sm text-danger">
            {message}
          </p>
        ))}
      </div>
    </div>
  );
}
