import { describe, expect, it } from "vitest";
import { skinPath } from "../../liquid/skin.ts";
import {
  type Frame,
  frameAt,
  gapBetween,
  LOOP_MS,
  SENTENCE,
  SPACE,
  STEPS,
  STILL_MS,
} from "./script.ts";

/** Every 10ms of one loop. Fine enough to catch a gap between two acts, cheap enough to be free. */
function walk(): Frame[] {
  const frames: Frame[] = [];
  for (let ms = 0; ms < LOOP_MS; ms += 10) frames.push(frameAt(ms));
  return frames;
}

describe("the clock", () => {
  it("wraps, so the loop cannot jump when it comes round", () => {
    // The component hands this a monotonic clock forever. If the wrap were the caller's job, the
    // seam would be one frame of the wrong picture every fourteen seconds — the kind of thing
    // nobody can reproduce on demand.
    for (const ms of [0, 1234, 9000, LOOP_MS - 1]) {
      expect(frameAt(ms + LOOP_MS)).toEqual(frameAt(ms));
      expect(frameAt(ms - LOOP_MS)).toEqual(frameAt(ms));
    }
  });

  it("plays every act, in order, with nothing in between", () => {
    const order = ["arrive", "type", "send", "pour-in", "work", "pour-out", "preview", "rest"];
    const seen: string[] = [];
    for (const frame of walk()) {
      if (seen[seen.length - 1] !== frame.act) seen.push(frame.act);
    }

    expect(seen).toEqual(order);
  });
});

describe("the sentence", () => {
  it("starts empty and only ever grows", () => {
    // Backwards typing is what an off-by-one in the progress maths looks like on screen, and it
    // is oddly hard to notice at 90ms a character.
    let longest = -1;
    for (const frame of walk()) {
      expect(frame.typed.length).toBeGreaterThanOrEqual(longest);
      expect(SENTENCE.startsWith(frame.typed)).toBe(true);
      longest = frame.typed.length;
    }

    expect(frameAt(0).typed).toBe("");
  });

  it("is finished before the button is pressed", () => {
    // A send that fires mid-word says the demo is on a timer rather than following the story.
    for (const frame of walk()) {
      if (frame.send > 0) expect(frame.typed).toBe(SENTENCE);
    }
  });
});

describe("the pointer", () => {
  it("arrives, presses once, and leaves", () => {
    const frames = walk();
    const pressing = frames.filter((frame) => frame.send > 0);

    expect(frames[0]?.cursor.alpha).toBeLessThan(0.2);
    expect(pressing.length).toBeGreaterThan(10);
    expect(frames[frames.length - 1]?.cursor.alpha).toBeLessThan(0.05);
  });

  it("does not reach the button before it has finished typing", () => {
    // The press has to read as caused by the pointer getting there; a cursor already parked on
    // the button while the words are still arriving reads as two unrelated animations.
    const buttonX = SPACE.w - 64;
    for (const frame of walk()) {
      if (frame.act === "type") expect(frame.cursor.x).toBeLessThan(buttonX);
    }
  });
});

describe("the tool calls", () => {
  it("arrive one at a time, none of them before the panel exists", () => {
    for (const frame of walk()) {
      if (frame.act === "arrive" || frame.act === "type" || frame.act === "send") {
        expect(frame.steps.every((state) => state === "pending")).toBe(true);
      }
    }

    const midWork = walk().filter((frame) => frame.act === "work");
    const started = midWork.map((frame) => frame.steps.filter((s) => s !== "pending").length);

    // Monotone: a step that un-arrives is a fixture reading the clock backwards.
    expect(started).toEqual([...started].sort((a, b) => a - b));
    expect(started[started.length - 1]).toBe(STEPS.length);
  });

  it("leaves the last one still running, because the turn has not finished", () => {
    const last = frameAt(LOOP_MS - 1).steps[STEPS.length - 1];

    expect(last).toBe("running");
  });
});

describe("the beat beside the stage", () => {
  it("follows the act the reader is being shown", () => {
    expect(frameAt(0).beat).toBe(1);
    expect(frameAt(500).beat).toBe(1);
    expect(
      walk()
        .filter((f) => f.act === "work")
        .every((f) => f.beat === 2),
    ).toBe(true);
    expect(
      walk()
        .filter((f) => f.act === "preview")
        .every((f) => f.beat === 3),
    ).toBe(true);
  });

  it("never goes backwards inside one loop", () => {
    // The copy column reads top to bottom; a highlight that jumps back up mid-loop reads as the
    // demo losing its place.
    let beat = 1;
    for (const frame of walk()) {
      expect(frame.beat).toBeGreaterThanOrEqual(beat);
      beat = frame.beat;
    }
  });
});

describe("the shape", () => {
  it("stays fused on every single frame", () => {
    // This is the invariant the whole effect rests on. Two shapes merge only while the blend
    // exceeds twice the gap between them, and the pour moves the tab *and* the body — so a
    // frame in the middle can tear the shape in half while both ends look perfect. It is a
    // gradual, machine-dependent failure that no screenshot of a finished pour would show.
    for (const frame of walk()) {
      const gap = gapBetween(frame.body, frame.tab);
      const born = frame.tab.w > 0 && frame.tab.h > 0;
      if (born) expect(frame.k).toBeGreaterThan(2 * gap);
    }
  });

  it("really does trace one island through a whole pour", () => {
    // The rule above, checked the expensive way at a few points: what the reader sees is the
    // outline, not the arithmetic.
    for (const ms of [3900, 4100, 4300, 4500, 9400, 9700, 9900, 12000]) {
      const frame = frameAt(ms);
      const path = skinPath(
        [
          { id: "body", ...frame.body, cornerRadius: frame.bodyRadius },
          { id: "tab", ...frame.tab, cornerRadius: frame.tabRadius },
        ],
        { k: frame.k, cell: 5 },
      );

      expect(path.d.split("Z").filter((part) => part.trim() !== "")).toHaveLength(1);
    }
  });

  it("keeps the traced path small enough to write sixty times a second", () => {
    // A deterministic stand-in for per-frame cost: the work is proportional to the number of
    // points, and a timing assertion would be flaky on somebody else's machine.
    let longest = 0;
    for (let ms = 0; ms < LOOP_MS; ms += 200) {
      const frame = frameAt(ms);
      const path = skinPath(
        [
          { id: "body", ...frame.body, cornerRadius: frame.bodyRadius },
          { id: "tab", ...frame.tab, cornerRadius: frame.tabRadius },
        ],
        { k: frame.k, cell: 6 },
      );
      longest = Math.max(longest, path.d.length);
    }

    expect(longest).toBeLessThan(14_000);
  });
});

describe("the still", () => {
  it("is a turn in progress, not an empty box", () => {
    // What a reader who asked for no motion is left looking at. An idle prompt bar would say the
    // product does nothing.
    const frame = frameAt(STILL_MS);

    expect(frame.act).toBe("work");
    expect(frame.steps.some((state) => state !== "pending")).toBe(true);
    expect(frame.cursor.alpha).toBeLessThan(0.05);
  });
});
