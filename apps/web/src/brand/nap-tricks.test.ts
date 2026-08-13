import { describe, expect, it } from "vitest";
import { nextTrick, TRICKS } from "./nap-tricks.ts";

/**
 * The choosing, which is the half that can be wrong without looking wrong: a ghost stuck on an
 * undefined trick simply stops moving, and a loading state that stops moving reads as a page
 * that has died.
 */

describe("choosing the next trick", () => {
  it("never repeats the one just performed", () => {
    // Repeating is what a weighted pick does naturally, and it is the single outcome that undoes
    // the point of having five: two hops in a row read as one long animation.
    for (const previous of TRICKS) {
      for (let step = 0; step <= 20; step += 1) {
        expect(nextTrick(previous, step / 20).name).not.toBe(previous.name);
      }
    }
  });

  it("can reach every trick", () => {
    // A weight that never wins is a trick nobody ever sees — which is indistinguishable from
    // having deleted it, except that the CSS for it is still being shipped.
    const seen = new Set<string>();
    for (let step = 0; step < 200; step += 1) seen.add(nextTrick(undefined, step / 200).name);

    expect([...seen].toSorted()).toEqual(TRICKS.map((trick) => trick.name).toSorted());
  });

  it("favours the quiet ones", () => {
    // The weights are the difference between a character and a busy indicator: a spin every
    // couple of seconds is a spinner wearing a costume.
    const picks = Array.from({ length: 1000 }, (_, step) => nextTrick(undefined, step / 1000).name);
    const count = (name: string) => picks.filter((pick) => pick === name).length;

    expect(count("glance")).toBeGreaterThan(count("spin"));
  });

  it("survives a number at or past the end of the range", () => {
    // `Math.random()` never returns 1, but this takes the number from its caller, and the
    // failure mode is an undefined trick rather than anything that would throw.
    for (const random of [0, 1, 1.5, -0.2, Number.NaN]) {
      expect(TRICKS.map((trick) => trick.name)).toContain(nextTrick(undefined, random).name);
    }
  });

  it("holds each trick long enough to finish it", () => {
    // The durations belong to the animations in `globals.css`; one cut short drops the ghost
    // through the floor mid-hop.
    for (const trick of TRICKS) expect(trick.ms).toBeGreaterThanOrEqual(1000);
  });
});
