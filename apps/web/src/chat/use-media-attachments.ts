"use client";

import { MAX_ATTACHMENTS, type MediaAttachment, MediaAttachmentsSchema } from "@nap/shared/media";
import { useEffect, useRef, useState } from "react";

export type DraftAttachment = {
  id: string;
  /** Recovered prepared frames have no original file URL. */
  previewUrl: string | undefined;
  media: MediaAttachment;
};

const ACCEPTED_IMAGES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const ACCEPTED_VIDEOS = new Set(["video/mp4", "video/webm", "video/quicktime"]);
export const MEDIA_ACCEPT = [...ACCEPTED_IMAGES, ...ACCEPTED_VIDEOS].join(",");

export function useMediaAttachments() {
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string>();
  const urls = useRef(new Set<string>());
  const working = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const allocated = urls.current;
    return () => {
      mounted.current = false;
      for (const url of allocated) URL.revokeObjectURL(url);
      allocated.clear();
    };
  }, []);

  const add = async (files: File[]) => {
    if (working.current || files.length === 0) return;
    setError(undefined);
    if (attachments.length + files.length > MAX_ATTACHMENTS) {
      setError(`You can attach up to ${MAX_ATTACHMENTS} images or videos.`);
      return;
    }
    working.current = true;
    setProcessing(true);
    const additions: (DraftAttachment & { previewUrl: string })[] = [];
    try {
      for (const file of files) {
        const previewUrl = URL.createObjectURL(file);
        urls.current.add(previewUrl);
        try {
          const media = await prepareMedia(file, previewUrl);
          additions.push({ id: crypto.randomUUID(), previewUrl, media });
        } catch (failure) {
          URL.revokeObjectURL(previewUrl);
          urls.current.delete(previewUrl);
          throw failure;
        }
      }
      const next = [...attachments, ...additions];
      const parsed = MediaAttachmentsSchema.safeParse(next.map((item) => item.media));
      if (!parsed.success)
        throw new Error("Attachments are too large. Try fewer or smaller files.");
      if (mounted.current) setAttachments(next);
      else for (const item of additions) URL.revokeObjectURL(item.previewUrl);
    } catch (failure) {
      for (const item of additions) {
        URL.revokeObjectURL(item.previewUrl);
        urls.current.delete(item.previewUrl);
      }
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : "Could not read that file.");
    } finally {
      working.current = false;
      if (mounted.current) setProcessing(false);
    }
  };

  return {
    attachments,
    processing,
    error,
    add,
    setAttachments,
    release: (items: readonly DraftAttachment[]) => {
      for (const item of items) {
        if (item.previewUrl === undefined) continue;
        URL.revokeObjectURL(item.previewUrl);
        urls.current.delete(item.previewUrl);
      }
    },
    remove: (id: string) =>
      setAttachments((items) => {
        const removed = items.find((item) => item.id === id);
        if (removed?.previewUrl !== undefined) {
          URL.revokeObjectURL(removed.previewUrl);
          urls.current.delete(removed.previewUrl);
        }
        return items.filter((item) => item.id !== id);
      }),
  };
}

function frame(source: CanvasImageSource, width: number, height: number, timestamp: number) {
  const scale = Math.min(1, 1280 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Your browser could not prepare this image.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return {
    data: canvas.toDataURL("image/jpeg", 0.8).split(",")[1] ?? "",
    mediaType: "image/jpeg" as const,
    timestamp,
  };
}

function waitForMedia(element: HTMLMediaElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      element.removeEventListener(event, done);
      element.removeEventListener("error", fail);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("This video could not be read. Try an MP4 or WebM file."));
    };
    const timeout = setTimeout(fail, 15_000);
    element.addEventListener(event, done, { once: true });
    element.addEventListener("error", fail, { once: true });
  });
}

export async function prepareMedia(file: File, url: string): Promise<MediaAttachment> {
  if (ACCEPTED_IMAGES.has(file.type)) {
    if (file.size > 10 * 1024 * 1024) throw new Error("Images must be 10 MB or smaller.");
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error("This image could not be read. Try a PNG, JPEG, WebP, or GIF.");
    }
    return {
      kind: "image",
      name: file.name,
      frames: [frame(image, image.naturalWidth, image.naturalHeight, 0)],
    };
  }
  if (!ACCEPTED_VIDEOS.has(file.type))
    throw new Error("Choose a PNG, JPEG, WebP, GIF, MP4, WebM, or MOV file.");
  if (file.size > 50 * 1024 * 1024) throw new Error("Videos must be 50 MB or smaller.");
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  try {
    const loaded = waitForMedia(video, "loadeddata");
    video.src = url;
    await loaded;
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 120) {
      throw new Error("Choose a video up to 2 minutes long.");
    }
    const frames = [];
    for (const proportion of [0.05, 0.5, 0.95]) {
      const timestamp = video.duration * proportion;
      const sought = waitForMedia(video, "seeked");
      video.currentTime = timestamp;
      await sought;
      frames.push(frame(video, video.videoWidth, video.videoHeight, timestamp));
    }
    return { kind: "video", name: file.name, duration: video.duration, frames };
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}
