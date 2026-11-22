import { type RefObject, useEffect } from "react";

// An exponential ease keeps the same feel at different display refresh rates.
const SCROLL_TIME_CONSTANT_MS = 50;

export function useSmoothScroll(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const page = ref.current;
    if (!page) return;

    const viewport = document.documentElement;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame: number | undefined;
    let position = 0;
    let target = 0;
    let previousTime = 0;

    function cancel() {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined;
    }

    function step(time: number) {
      frame = undefined;
      // A native scroll, such as the scrollbar being dragged, takes over the viewport.
      if (reducedMotion.matches || Math.abs(window.scrollY - position) > 1) return;

      // A wheel event can arrive after the browser timestamps its next frame.
      const elapsed = Math.max(0, time - previousTime);
      const progress = 1 - Math.exp(-elapsed / SCROLL_TIME_CONSTANT_MS);
      previousTime = Math.max(time, previousTime);
      position += (target - position) * progress;
      if (Math.abs(target - position) < 1) position = target;
      window.scrollTo({ top: position, behavior: "instant" });
      if (position !== target) frame = window.requestAnimationFrame(step);
    }

    function wheel(event: WheelEvent) {
      const unit = event.deltaMode;
      if (
        reducedMotion.matches ||
        event.defaultPrevented ||
        !event.cancelable ||
        event.ctrlKey ||
        event.shiftKey ||
        Math.abs(event.deltaX) >= Math.abs(event.deltaY)
      )
        return;

      const insideScrollArea = event
        .composedPath()
        .some(
          (node) =>
            node instanceof HTMLElement &&
            node !== viewport &&
            node !== document.body &&
            (node instanceof HTMLSelectElement ||
              (node.scrollHeight > node.clientHeight &&
                /^(auto|scroll)$/.test(window.getComputedStyle(node).overflowY))),
        );
      if (insideScrollArea) return;

      const current = window.scrollY;
      const limit = viewport.scrollHeight - viewport.clientHeight;
      const delta = event.deltaY * (unit === 1 ? 16 : unit === 2 ? viewport.clientHeight : 1);
      const moving = frame !== undefined && Math.abs(current - position) <= 1;
      // Drop the old destination when the reader reverses direction.
      const base = moving && Math.sign(target - position) === Math.sign(delta) ? target : current;
      target = Math.max(0, Math.min(base + delta, limit));
      if (target === current) {
        cancel();
        return;
      }

      event.preventDefault();
      if (!moving) {
        cancel();
        position = current;
        previousTime = performance.now();
        frame = window.requestAnimationFrame(step);
      }
    }

    // Let Next jump directly to the restored position during route navigation.
    viewport.dataset.scrollBehavior = "smooth";
    page.addEventListener("wheel", wheel, { passive: false });
    page.addEventListener("pointerdown", cancel);
    window.addEventListener("keydown", cancel);
    reducedMotion.addEventListener("change", cancel);
    return () => {
      cancel();
      delete viewport.dataset.scrollBehavior;
      page.removeEventListener("wheel", wheel);
      page.removeEventListener("pointerdown", cancel);
      window.removeEventListener("keydown", cancel);
      reducedMotion.removeEventListener("change", cancel);
    };
  }, [ref]);
}
