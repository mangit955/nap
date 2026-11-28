import { render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { LiveStage } from "./live-stage.tsx";

/**
 * The stage holds its terminal lines and cursor back until it plays, and it plays when the element
 * it observes comes on screen (`use-reveal.ts`). So nothing held back can be seen before it plays
 * exactly when the observed element contains all of it. A real browser is needed to see the motion;
 * this pins the containment that makes it safe.
 */
let observed: Element[] = [];
let original: typeof IntersectionObserver | undefined;

class RecordingObserver {
  observe(element: Element) {
    observed.push(element);
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

beforeEach(() => {
  observed = [];
  original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = RecordingObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  if (original !== undefined) globalThis.IntersectionObserver = original;
});

it("watches an element that holds every piece the stage holds back", () => {
  const { container } = render(<LiveStage />);
  // The pieces the `pending` rule in `showcase/showcase.css` hides.
  const held = [...container.querySelectorAll(".n1-term-l, .n1-cursor")];
  expect(held.length).toBeGreaterThan(5);
  expect(observed).toHaveLength(1);
  const [target] = observed;
  for (const piece of held) expect(target?.contains(piece)).toBe(true);
  // And not the whole section, whose top edge is on screen on load at desktop widths.
  expect(target).not.toBe(container.querySelector("#live"));
});
