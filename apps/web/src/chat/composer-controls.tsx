"use client";

import { useRef } from "react";
import type { useDictation } from "../dashboard/use-dictation.ts";
import { type DraftAttachment, MEDIA_ACCEPT } from "./use-media-attachments.ts";

export const CONTROL_CLASS =
  "grid size-8 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40";

export function AttachmentButton({
  disabled,
  onFiles,
}: {
  disabled: boolean;
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={MEDIA_ACCEPT}
        multiple
        aria-label="Attach images or videos"
        className="sr-only"
        tabIndex={-1}
        disabled={disabled}
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <button
        type="button"
        aria-label="Add images or videos"
        title="Add images or videos"
        disabled={disabled}
        onClick={() => input.current?.click()}
        className={CONTROL_CLASS}
      >
        <svg
          viewBox="0 0 24 24"
          className="size-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </>
  );
}

export function DictationButton({
  dictation,
  disabled,
}: {
  dictation: ReturnType<typeof useDictation>;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={dictation.listening ? "Stop dictation" : "Start dictation"}
      aria-pressed={dictation.listening}
      title={
        dictation.supported ? "Dictate a message" : "Voice input is not supported by this browser"
      }
      disabled={disabled || !dictation.supported}
      onClick={dictation.toggle}
      className={`${CONTROL_CLASS} ${dictation.listening ? "bg-accent-tint text-accent-ink" : ""}`}
    >
      <svg
        viewBox="0 0 24 24"
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <rect x="9" y="3" width="6" height="12" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
      </svg>
    </button>
  );
}

export function AttachmentTray({
  attachments,
  disabled,
  onRemove,
}: {
  attachments: readonly DraftAttachment[];
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="px-4 pt-4">
      <ul aria-label="Attachments" className="flex flex-wrap gap-2">
        {attachments.map(({ id, previewUrl, media }) => (
          <li key={id} className="relative w-20 shrink-0">
            {media.kind === "image" ? (
              // biome-ignore lint/performance/noImgElement: this is a local blob URL, not an optimizable network image.
              <img
                src={previewUrl}
                alt={media.name}
                className="h-16 w-full rounded-lg border border-edge object-cover"
              />
            ) : (
              <video
                src={previewUrl}
                aria-label={media.name}
                muted
                playsInline
                controls
                className="h-16 w-full rounded-lg border border-edge object-cover"
              />
            )}
            <span className="mt-1 block min-w-0">
              <span className="block truncate text-xs text-ink-2" title={media.name}>
                {media.name}
              </span>
              <span className="text-[10px] text-muted">
                {media.kind === "video" ? `${media.duration.toFixed(0)}s · 3 frames` : "Image"}
              </span>
            </span>
            <button
              type="button"
              aria-label={`Remove ${media.name}`}
              disabled={disabled}
              onClick={() => onRemove(id)}
              className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border border-edge bg-panel text-xs text-ink-2 hover:text-ink"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {attachments.some((item) => item.media.kind === "video") && (
        <p className="mt-2 text-[11px] text-muted">
          Videos are shared as 3 still frames. Audio is not included.
        </p>
      )}
    </div>
  );
}
