"use client";

import type { MediaAttachment } from "@nap/shared/media";
import type { ModelChoice } from "@nap/shared/models-protocol";
import { useEffect, useRef } from "react";
import { AttachmentButton, AttachmentTray, DictationButton } from "../chat/composer-controls.tsx";
import { ModelPicker } from "../chat/model-picker.tsx";
import { useMediaAttachments } from "../chat/use-media-attachments.ts";
import { EXAMPLE_PROMPTS } from "./example-prompts.ts";
import { appendDictation, useDictation } from "./use-dictation.ts";

export function DashboardHero({
  name,
  value,
  busy = false,
  error,
  prompts = EXAMPLE_PROMPTS,
  models = [],
  modelsLoading = false,
  model,
  onModelChange,
  onAddKey,
  onChange,
  onSubmit,
}: {
  name: string;
  value: string;
  busy?: boolean;
  error?: string | undefined;
  prompts?: readonly string[];
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
    <div className="relative flex min-h-full flex-col justify-center px-5 py-20 sm:px-10">
      <div className="mx-auto flex w-full max-w-[720px] flex-col">
        <p className="mb-3 text-sm text-muted">Your workspace, ready when you are</p>
        <h1 className="mb-8 text-[28px] font-medium tracking-tight text-ink sm:text-[32px]">
          {name === "there" ? "What would you like to build?" : `What are we building, ${name}?`}
        </h1>
        <fieldset
          aria-label="New session composer"
          className="rounded-2xl border border-edge bg-field shadow-card transition-colors focus-within:border-line-strong"
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
            placeholder="Describe what you want to build…"
            className="block min-h-32 w-full resize-none bg-transparent px-5 pt-4 pb-3 text-[15px] leading-relaxed text-ink outline-none placeholder:text-muted disabled:text-muted"
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-3">
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
                className="grid size-9 place-items-center rounded-full bg-accent text-white transition-colors hover:bg-accent/90 disabled:bg-hover disabled:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs text-muted">Try a starting point</span>
          {prompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => {
                onChange(prompt);
                box.current?.focus();
              }}
              className="rounded-lg border border-edge px-3 py-1.5 text-xs text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-accent"
            >
              {prompt}
            </button>
          ))}
        </div>
        <p className="mt-5 text-[11px] text-muted">
          Enter to send <span className="px-1.5 text-line-strong">·</span> Shift + Enter for a new
          line
        </p>
      </div>
    </div>
  );
}
