import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useDocumentScrollLock } from "./use-document-scroll-lock.ts";

/**
 * The last line of defence against a shell that scrolls the window.
 *
 * `.test.tsx` with no JSX in it: filename decides the project, and a `.test.ts` under `apps/web`
 * runs in Node with no `document` at all.
 */

afterEach(() => {
  document.documentElement.style.overflow = "";
  document.body.style.overflow = "";
});

describe("the document scroll lock", () => {
  it("clamps both the root element and the body", () => {
    // Both, because which of the two owns the viewport's scrollbar is a fact about the
    // stylesheet: the propagation rules hand it to `html` unless `body` has said otherwise.
    renderHook(() => useDocumentScrollLock());

    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("puts back what it found on the way out", () => {
    // A shell is one route among several, and the landing, sign-in and welcome pages are
    // full-length scrolling documents. Leaving the clamp behind on unmount would make the next
    // page somebody navigates to unscrollable, which is a far worse bug than the one this fixes.
    document.body.style.overflow = "scroll";

    const { unmount } = renderHook(() => useDocumentScrollLock());
    unmount();

    expect(document.documentElement.style.overflow).toBe("");
    expect(document.body.style.overflow).toBe("scroll");
  });
});
