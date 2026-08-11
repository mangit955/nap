/**
 * Setup for the `web` test project.
 *
 * Kept to this project rather than the whole suite: `@testing-library/jest-dom` and the
 * automatic cleanup below only make sense in a DOM, and loading them into the hundred-odd
 * Node tests would cost time and blur where the browser boundary is.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Without this, a component from one test is still mounted during the next, so
// `getByRole` finds two matches and fails in a way that points at the wrong test.
afterEach(cleanup);

/*
 * Four browser APIs jsdom does not implement, which the rim light on the landing page uses.
 *
 * These are stubs, not fakes: nothing here is meant to make the effect testable, because the
 * effect is colour and has no accessible surface to assert on. They exist so a component that
 * happens to contain a lit box still mounts. Every one of them is a *quiet* no-op in the
 * direction the code already handles — an observer that never fires means the light never
 * pulses, and a null canvas context means `buildMask` yields no mask and the box renders
 * unlit, which is exactly what it does in a browser that has run out of contexts.
 */
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = NoopObserver as unknown as typeof ResizeObserver;
}

if (typeof globalThis.IntersectionObserver === "undefined") {
  globalThis.IntersectionObserver = NoopObserver as unknown as typeof IntersectionObserver;
}

// jsdom's own `getContext` raises a "not implemented" error through the virtual console, which
// is noise on every test that mounts the box. Returning null says the same thing quietly.
HTMLCanvasElement.prototype.getContext = () => null;
