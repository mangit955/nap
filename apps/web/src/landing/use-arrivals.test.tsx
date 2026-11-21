import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useArrivals } from "./use-arrivals.ts";

/**
 * The demos move by easing in what is new, and only that. Each case is one way it could look
 * wrong on the page: something already on screen jumping again, everything arriving at once, or
 * motion for somebody who asked for none.
 */

let reduce = false;
let motionChanged: ((event: { matches: boolean }) => void) | undefined;
const animated: { element: Element; delay: number; finished: boolean }[] = [];
const realAnimate = Element.prototype.animate;
const realMatchMedia = window.matchMedia;

beforeEach(() => {
  reduce = false;
  motionChanged = undefined;
  animated.length = 0;
  Element.prototype.animate = function animate(_frames, options) {
    const delay = typeof options === "object" ? Number(options.delay ?? 0) : 0;
    const entry = { element: this, delay, finished: false };
    animated.push(entry);
    return {
      finish() {
        entry.finished = true;
      },
    } as Animation;
  };
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes("reduce") && reduce,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener(_: string, listener: (event: { matches: boolean }) => void) {
      motionChanged = listener;
    },
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  Element.prototype.animate = realAnimate;
  window.matchMedia = realMatchMedia;
});

function Demo({ beat, items, from }: { beat: number; items: string[]; from: "shown" | "hidden" }) {
  const ref = useRef<HTMLDivElement>(null);
  useArrivals(ref, beat, from);
  return (
    <div ref={ref}>
      {items.map((item) => (
        <p key={item} data-arrive>
          {item}
        </p>
      ))}
      <p>never moves</p>
    </div>
  );
}
const names = () => animated.map(({ element }) => element.textContent);

describe("easing in what arrives", () => {
  it("leaves what was on screen at the start alone, and eases in only what is new", () => {
    const view = render(<Demo beat={0} items={["plan"]} from="shown" />);
    expect(animated).toHaveLength(0);
    view.rerender(<Demo beat={1} items={["plan", "step", "reply"]} from="shown" />);
    expect(names()).toEqual(["step", "reply"]);
    expect(animated[1]?.delay).toBeGreaterThan(animated[0]?.delay ?? 0);
  });

  it("does not ease in the same element twice", () => {
    const view = render(<Demo beat={0} items={["plan"]} from="shown" />);
    view.rerender(<Demo beat={1} items={["plan", "step"]} from="shown" />);
    view.rerender(<Demo beat={2} items={["plan", "step"]} from="shown" />);
    expect(names()).toEqual(["step"]);
  });

  it("brings everything in, one after another, when the section was waiting to be seen", () => {
    const view = render(<Demo beat={0} items={["a", "b", "c"]} from="hidden" />);
    expect(animated).toHaveLength(0);
    view.rerender(<Demo beat={1} items={["a", "b", "c"]} from="hidden" />);
    expect(names()).toEqual(["a", "b", "c"]);
    expect(animated.map(({ delay }) => delay)).toEqual(
      [...animated.map(({ delay }) => delay)].sort((x, y) => x - y),
    );
  });

  it("finishes what is still arriving the moment reduced motion is turned on", () => {
    const view = render(<Demo beat={0} items={["plan"]} from="shown" />);
    view.rerender(<Demo beat={1} items={["plan", "step", "reply"]} from="shown" />);
    expect(animated.map(({ finished }) => finished)).toEqual([false, false]);
    act(() => motionChanged?.({ matches: true }));
    expect(animated.map(({ finished }) => finished)).toEqual([true, true]);
  });

  it("moves nothing for somebody who asked for no motion", () => {
    reduce = true;
    const view = render(<Demo beat={0} items={["plan"]} from="shown" />);
    view.rerender(<Demo beat={1} items={["plan", "step"]} from="shown" />);
    expect(animated).toHaveLength(0);
  });
});
