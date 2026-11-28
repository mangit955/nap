import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { LiveStage } from "./live-stage.tsx";

/**
 * The stage holds its terminal lines and cursor back until it plays, and it plays when the element
 * it observes comes on screen (`use-reveal.ts`). So nothing held back can be seen before it plays
 * exactly when the observed element contains all of it. A real browser is needed to see the motion;
 * this pins the containment that makes it safe.
 */
/** The pieces held back, read from the stage's own `pending` rule, so a piece added there is held
 *  to the same containment. */
const HELD = (() => {
  const css = readFileSync(join(import.meta.dirname, "showcase", "showcase.css"), "utf8");
  const pieces = css.match(/\.n1-stage\[data-reveal="pending"\]\s*:is\(([^)]*)\)/)?.[1];
  if (pieces === undefined) throw new Error("the stage's pending rule has moved; update this test");
  return pieces;
})();

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
  const held = [...container.querySelectorAll(HELD)];
  expect(held.length).toBeGreaterThan(5);
  expect(observed).toHaveLength(1);
  const [target] = observed;
  for (const piece of held) expect(target?.contains(piece)).toBe(true);
  // And not the whole section, whose top edge is on screen on load at desktop widths.
  expect(target).not.toBe(container.querySelector("#live"));
});
