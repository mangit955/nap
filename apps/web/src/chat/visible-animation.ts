/**
 * Shimmers that run only while somebody could be watching them.
 *
 * The timeline's live labels animate forever, and a transcript scrolled away from them, or a tab
 * left in the background, would otherwise keep a compositor busy painting light nobody sees.
 * One shared `IntersectionObserver` writes `--visible-animation-state` onto each element it is
 * attached to — `running` while it is on screen, the tab is visible and motion is allowed, and
 * `paused` otherwise — and the shimmer utilities in `globals.css` read it as their
 * `animation-play-state`. Starting `paused` is deliberate: an element nothing has observed yet,
 * a jsdom test, a browser without the API, all hold still rather than run unchecked.
 *
 * Ported from T3 Code's `lib/visibleAnimation.ts`, MIT — see `apps/web/THIRD_PARTY_NOTICES.md`.
 * Used as a ref callback, which React 19 calls with the element and whose return value it calls
 * on detach.
 */

type ObservedAnimation = { element: HTMLElement | SVGElement; intersecting: boolean };

const animations = new Map<Element, ObservedAnimation>();
let observer: IntersectionObserver | null = null;
let reducedMotion: MediaQueryList | null = null;

function update(animation: ObservedAnimation) {
  const running =
    animation.intersecting && document.visibilityState === "visible" && !reducedMotion?.matches;
  animation.element.style.setProperty("--visible-animation-state", running ? "running" : "paused");
  animation.element.style.setProperty(
    "--visible-animation-will-change",
    running ? "transform" : "auto",
  );
}

function updateAll() {
  for (const animation of animations.values()) update(animation);
}

export function observeVisibleAnimation(element: HTMLElement | SVGElement | null) {
  if (element === null) return;
  element.style.setProperty("--visible-animation-state", "paused");
  element.style.setProperty("--visible-animation-will-change", "auto");
  if (typeof IntersectionObserver === "undefined") return;

  if (observer === null) {
    reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.addEventListener("change", updateAll);
    document.addEventListener("visibilitychange", updateAll);
    observer = new IntersectionObserver((entries, source) => {
      if (source !== observer) return;
      for (const entry of entries) {
        const animation = animations.get(entry.target);
        if (animation === undefined) continue;
        animation.intersecting = entry.isIntersecting;
        update(animation);
      }
    });
  }

  const animation = { element, intersecting: false };
  animations.set(element, animation);
  observer.observe(element);

  return () => {
    if (animations.get(element) !== animation) return;
    animations.delete(element);
    observer?.unobserve(element);
    element.style.setProperty("--visible-animation-state", "paused");
    element.style.setProperty("--visible-animation-will-change", "auto");
    if (animations.size === 0) {
      observer?.disconnect();
      observer = null;
      reducedMotion?.removeEventListener("change", updateAll);
      reducedMotion = null;
      document.removeEventListener("visibilitychange", updateAll);
    }
  };
}
