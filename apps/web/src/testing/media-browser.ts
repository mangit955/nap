import { vi } from "vitest";

/** The native decoder and canvas boundary, without allocating native image or video buffers. */
export function mediaBrowser() {
  const decode = vi.fn(async () => {});
  const createObjectURL = vi.fn((file: Blob) => `blob:reference-${file.size}-${created++}`);
  const revokeObjectURL = vi.fn<(url: string) => void>();
  const encoded = vi.fn(() => "data:image/jpeg;base64,/9j/AAAA");
  const draws: { width: number; height: number }[] = [];
  const fills: { color: string; width: number; height: number }[] = [];
  const images: HTMLImageElement[] = [];
  let created = 0;
  const replacements: [object, string][] = [
    [URL, "createObjectURL"],
    [URL, "revokeObjectURL"],
    [HTMLCanvasElement.prototype, "getContext"],
    [HTMLCanvasElement.prototype, "toDataURL"],
  ];
  const originals = replacements.map(([target, key]) => ({
    target,
    key,
    descriptor: Object.getOwnPropertyDescriptor(target, key),
  }));
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value() {
      return {
        fillStyle: "",
        fillRect(_x: number, _y: number, width: number, height: number) {
          fills.push({ color: this.fillStyle, width, height });
        },
        drawImage(
          _source: CanvasImageSource,
          _x: number,
          _y: number,
          width: number,
          height: number,
        ) {
          draws.push({ width, height });
        },
      };
    },
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true,
    value: encoded,
  });
  // biome-ignore lint/complexity/useArrowFunction: Image is called with new, so the fake must remain constructable.
  vi.stubGlobal("Image", function () {
    const image = document.createElement("img");
    Object.defineProperties(image, {
      decode: { value: decode },
      naturalWidth: { value: 1600 },
      naturalHeight: { value: 800 },
    });
    images.push(image);
    return image;
  });
  return {
    decode,
    createObjectURL,
    revokeObjectURL,
    encoded,
    draws,
    fills,
    images,
    restore() {
      vi.unstubAllGlobals();
      for (const { target, key, descriptor } of originals) {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else Reflect.deleteProperty(target, key);
      }
    },
  };
}
