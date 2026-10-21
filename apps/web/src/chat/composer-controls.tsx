"use client";

import { X } from "lucide-react";
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

/**
 * What is attached, as T3 Code's composer shows it (MIT — see `apps/web/THIRD_PARTY_NOTICES.md`):
 * a row of 64px tiles, each with its own remove control in the corner. The name is the tile's
 * accessible name and its tooltip rather than a caption, so a row of references stays one tile
 * high.
 */
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
          <li
            key={id}
            title={
              media.kind === "video" ? `${media.name} · ${media.duration.toFixed(0)}s` : media.name
            }
            className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-edge bg-surface"
          >
            {media.kind === "image" || previewUrl === undefined ? (
              // biome-ignore lint/performance/noImgElement: local file previews and prepared frames need no network optimization.
              <img
                src={previewUrl ?? `data:image/jpeg;base64,${media.frames[0]?.data ?? ""}`}
                alt={media.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <video
                src={previewUrl}
                aria-label={media.name}
                muted
                playsInline
                className="h-full w-full object-cover"
              />
            )}
            <button
              type="button"
              aria-label={`Remove ${media.name}`}
              disabled={disabled}
              onClick={() => onRemove(id)}
              className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-surface/80 text-ink-2 backdrop-blur-sm transition-colors hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
            >
              <X aria-hidden="true" className="size-3" />
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
