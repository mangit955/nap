import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mediaBrowser } from "../testing/media-browser.ts";
import { prepareMedia, useMediaAttachments } from "./use-media-attachments.ts";

let browser: ReturnType<typeof mediaBrowser>;
beforeEach(() => {
  browser = mediaBrowser();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  browser.restore();
});

function file(name = "reference.png", type = "image/png", size?: number) {
  const result = new File(["tiny fixture"], name, { type });
  if (size !== undefined) Object.defineProperty(result, "size", { value: size });
  return result;
}

function videoBrowser(
  options: { duration?: number; error?: "load" | "seek"; stall?: boolean } = {},
) {
  const videos: HTMLMediaElement[] = [];
  const positions: number[] = [];
  const load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(options.duration ?? 4);
  vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(64);
  vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(32);
  vi.spyOn(HTMLMediaElement.prototype, "src", "set").mockImplementation(function (
    this: HTMLMediaElement,
    value,
  ) {
    this.setAttribute("src", value);
    videos.push(this);
    if (!options.stall)
      queueMicrotask(() =>
        this.dispatchEvent(new Event(options.error === "load" ? "error" : "loadeddata")),
      );
  });
  vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set").mockImplementation(function (
    this: HTMLMediaElement,
    value,
  ) {
    positions.push(value);
    queueMicrotask(() =>
      this.dispatchEvent(new Event(options.error === "seek" ? "error" : "seeked")),
    );
  });
  return { videos, positions, load };
}

describe("preparing references", () => {
  it("flattens and scales an image into one JPEG frame", async () => {
    const result = await prepareMedia(file(), "blob:image");
    expect(result).toEqual({
      kind: "image",
      name: "reference.png",
      frames: [{ mediaType: "image/jpeg", data: "/9j/AAAA", timestamp: 0 }],
    });
    expect(browser.images[0]?.src).toBe("blob:image");
    expect(browser.draws).toEqual([{ width: 1280, height: 640 }]);
    expect(browser.fills).toEqual([{ color: "#ffffff", width: 1280, height: 640 }]);
    expect(browser.encoded).toHaveBeenCalledWith("image/jpeg", 0.8);
  });

  it.each([
    ["large.png", "image/png", 10 * 1024 * 1024 + 1, "Images must be 10 MB"],
    ["large.mp4", "video/mp4", 50 * 1024 * 1024 + 1, "Videos must be 50 MB"],
    ["drawing.svg", "image/svg+xml", 1, "Choose a PNG"],
  ])("rejects %s before asking a decoder to read it", async (name, type, size, message) => {
    const video = videoBrowser();
    await expect(prepareMedia(file(name, type, size), "blob:rejected")).rejects.toThrow(message);
    expect(browser.decode).not.toHaveBeenCalled();
    expect(video.videos).toHaveLength(0);
  });

  it("reports a failed image decoder without attempting to encode", async () => {
    browser.decode.mockRejectedValueOnce(new Error("decoder refused"));
    await expect(prepareMedia(file(), "blob:bad")).rejects.toThrow("This image could not be read");
    expect(browser.encoded).not.toHaveBeenCalled();
  });

  it("samples three video frames with timestamps and releases the source", async () => {
    const video = videoBrowser();
    const result = await prepareMedia(file("flow.webm", "video/webm"), "blob:video");
    expect(result).toEqual({
      kind: "video",
      name: "flow.webm",
      duration: 4,
      frames: [0.2, 2, 3.8].map((timestamp) => ({
        mediaType: "image/jpeg",
        data: "/9j/AAAA",
        timestamp,
      })),
    });
    expect(video.positions).toEqual([0.2, 2, 3.8]);
    expect(video.videos[0]?.muted).toBe(true);
    expect(video.videos[0]?.getAttribute("src")).toBeNull();
    expect(video.load).toHaveBeenCalledOnce();
  });

  it.each([0, Number.POSITIVE_INFINITY, 121])(
    "refuses invalid duration %s before seeking",
    async (duration) => {
      const video = videoBrowser({ duration });
      await expect(prepareMedia(file("flow.mp4", "video/mp4"), "blob:video")).rejects.toThrow(
        "up to 2 minutes",
      );
      expect(video.positions).toEqual([]);
      expect(video.videos[0]?.getAttribute("src")).toBeNull();
      expect(video.load).toHaveBeenCalledOnce();
    },
  );

  it.each(["load", "seek"] as const)(
    "releases the native video after a %s error",
    async (error) => {
      const video = videoBrowser({ error });
      await expect(prepareMedia(file("flow.mp4", "video/mp4"), "blob:video")).rejects.toThrow(
        "This video could not be read",
      );
      expect(video.videos[0]?.getAttribute("src")).toBeNull();
      expect(video.load).toHaveBeenCalledOnce();
    },
  );

  it("bounds a stalled video load and clears its deadline", async () => {
    vi.useFakeTimers();
    const video = videoBrowser({ stall: true });
    const result = expect(
      prepareMedia(file("flow.mp4", "video/mp4"), "blob:video"),
    ).rejects.toThrow("This video could not be read");
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(video.videos[0]?.getAttribute("src")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("draft attachment ownership", () => {
  it("keeps four bounded references and releases one when removed", async () => {
    browser.encoded.mockReturnValue(`data:image/jpeg;base64,${"A".repeat(700_000)}`);
    const { result, unmount } = renderHook(() => useMediaAttachments());
    await act(async () => {
      await result.current.add([
        file("one.png"),
        file("two.png"),
        file("three.png"),
        file("four.png"),
      ]);
    });
    expect(result.current.attachments).toHaveLength(4);
    expect(result.current.error).toBeUndefined();
    const first = result.current.attachments[0];
    if (!first) throw new Error("Expected prepared reference");
    act(() => {
      result.current.remove(first.id);
    });
    expect(result.current.attachments).toHaveLength(3);
    expect(browser.revokeObjectURL).toHaveBeenCalledWith(first.previewUrl);
    const retained = result.current.attachments.map((item) => item.previewUrl);
    unmount();
    for (const url of retained) expect(browser.revokeObjectURL).toHaveBeenCalledWith(url);
  });

  it("rejects a fifth reference before allocating URLs", async () => {
    const { result } = renderHook(() => useMediaAttachments());
    await act(async () => {
      await result.current.add(Array.from({ length: 5 }, () => file()));
    });
    expect(result.current.error).toMatch(/up to 4/);
    expect(result.current.attachments).toEqual([]);
    expect(browser.createObjectURL).not.toHaveBeenCalled();
  });

  it("rejects an oversized aggregate and releases every URL from that batch", async () => {
    browser.encoded.mockReturnValue(`data:image/jpeg;base64,${"A".repeat(1_600_000)}`);
    const { result } = renderHook(() => useMediaAttachments());
    await act(async () => {
      await result.current.add([file("one.png"), file("two.png")]);
    });
    expect(result.current.attachments).toEqual([]);
    expect(result.current.error).toMatch(/too large/);
    expect(result.current.processing).toBe(false);
    for (const created of browser.createObjectURL.mock.results) {
      expect(browser.revokeObjectURL).toHaveBeenCalledWith(created.value);
    }
  });

  it("keeps existing references when a later file fails and releases the failed batch", async () => {
    const { result } = renderHook(() => useMediaAttachments());
    await act(async () => {
      await result.current.add([file("keep.png")]);
    });
    const kept = result.current.attachments;
    browser.decode.mockResolvedValueOnce().mockRejectedValueOnce(new Error("invalid image"));
    await act(async () => {
      await result.current.add([file("discard.png"), file("broken.png")]);
    });
    expect(result.current.attachments).toEqual(kept);
    expect(result.current.error).toMatch(/could not be read/);
    expect(browser.revokeObjectURL).not.toHaveBeenCalledWith(kept[0]?.previewUrl);
    for (const created of browser.createObjectURL.mock.results.slice(1)) {
      expect(browser.revokeObjectURL).toHaveBeenCalledWith(created.value);
    }
  });

  it("serializes preparation and releases a decoder result that finishes after unmount", async () => {
    let finish = () => {};
    browser.decode.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { result, unmount } = renderHook(() => useMediaAttachments());
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.add([file()]);
    });
    expect(result.current.processing).toBe(true);
    await act(async () => {
      await result.current.add([file("ignored.png")]);
    });
    expect(browser.createObjectURL).toHaveBeenCalledOnce();
    unmount();
    await act(async () => {
      finish();
      await pending;
    });
    expect(result.current.attachments).toEqual([]);
    expect(browser.revokeObjectURL).toHaveBeenCalledWith(
      browser.createObjectURL.mock.results[0]?.value,
    );
  });
});
