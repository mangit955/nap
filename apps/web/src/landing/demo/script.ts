/**
 * One turn of nap, written down as a function of time.
 *
 * The landing page plays a whole turn on a loop — a sentence typed into a prompt bar, the bar
 * pouring into a transcript that fills with tool calls, the transcript pouring into a browser
 * frame where the app comes up. This file is the entire choreography and it touches nothing: ask
 * it what the world looks like at a millisecond and it hands back a `Frame`.
 *
 * **The clock is an argument, not a timer.** That is what makes the interesting parts checkable
 * without rendering anything — whether the beats change in the right order, whether the typing
 * ever goes backwards, whether the shape can tear in half mid-pour. A component that owned its
 * own timers would leave all of that to be verified by eye, on a machine, once.
 *
 * **Everything is one continuum.** There are no keyframes to cross-fade between: the body box,
 * the tab that grows out of it and the blend that fuses them are all interpolated, so the pours
 * are the shape genuinely re-flowing. The tab is always present and simply has no size before it
 * is born, which keeps every frame the same shape of data and every consumer branch-free.
 */

/** A rectangle in the stage's own coordinates. */
export type Box = { x: number; y: number; w: number; h: number };

export type Act = "arrive" | "type" | "send" | "pour-in" | "work" | "pour-out" | "preview" | "rest";

/** Which of the three beats of copy is the one being illustrated right now. */
export type Beat = 1 | 2 | 3;

export type StepState = "pending" | "running" | "done";

export type Frame = {
  act: Act;
  beat: Beat;
  /** The main body of the shape, and the tab fused to it. */
  body: Box;
  bodyRadius: number;
  tab: Box;
  tabRadius: number;
  /** The blend the two are traced with. See `gapBetween` — this cannot be set independently. */
  k: number;
  /** What has been typed so far. Only ever grows within a loop. */
  typed: string;
  caret: boolean;
  cursor: { x: number; y: number; press: number; alpha: number };
  /** The dip on the send button, 0 to 1. */
  send: number;
  steps: readonly StepState[];
  /** How far each act's contents have faded in, 0 to 1. */
  prompt: number;
  panel: number;
  preview: number;
};

/** The stage's design space. The component scales this to whatever width it is given. */
export const SPACE = { w: 460, h: 300 } as const;

/** The sentence that types itself. Short enough to finish before anybody looks away. */
export const SENTENCE = "build me a habit tracker";

export const STEPS = [
  { verb: "Ran", target: "bun add zustand" },
  { verb: "Created", target: "src/lib/store.ts" },
  { verb: "Edited", target: "src/app/page.tsx" },
  { verb: "Reading", target: "src/app/layout.tsx" },
] as const;

/*
 * The clock. Each act ends where the next begins — there are no gaps, and a test walks every
 * millisecond of the loop to keep it that way.
 */
const ARRIVE_END = 800;
const TYPE_END = ARRIVE_END + SENTENCE.length * 92;
const SEND_END = TYPE_END + 700;
const POUR_IN_END = SEND_END + 800;
const WORK_END = POUR_IN_END + 4200;
const POUR_OUT_END = WORK_END + 800;
const PREVIEW_END = POUR_OUT_END + 2600;
/** The pause at the end, so the finished app is a thing you look at rather than a frame. */
export const LOOP_MS = PREVIEW_END + 1400;

/** When the cursor presses, and how long the button stays down. */
const PRESS_AT = TYPE_END + 380;
const PRESS_MS = 220;

/** How long a tool call spins before it resolves. The last one never does — it is still working. */
const STEP_EVERY = 900;
const STEP_SPINS = 620;

/**
 * The three shapes the stage takes.
 *
 * A tab with no size is a point *inside* the body, which contributes nothing to the outline — so
 * the bar has a tab too, it is simply not born yet. That is what lets the pour be one tween
 * rather than a special case with an appear step in it.
 */
const BAR = {
  body: { x: 30, y: 118, w: 400, h: 64 },
  bodyRadius: 22,
  // Well *inside* the bar, not on its edge. A zero-size box is still a point the blend pulls the
  // surface towards, so parked on the edge it raises a visible pimple on an otherwise clean bar —
  // an unborn tab has to be further from the outline than the blend can reach.
  tab: { x: 96, y: 150, w: 0, h: 0 },
  tabRadius: 4,
};

const PANEL = {
  body: { x: 30, y: 62, w: 400, h: 196 },
  bodyRadius: 20,
  /** Overlapping the body's top edge, the way a tab on a folder does. */
  tab: { x: 52, y: 28, w: 132, h: 44 },
  tabRadius: 15,
};

const FRAME = {
  body: { x: 34, y: 60, w: 392, h: 202 },
  bodyRadius: 18,
  /**
   * **Clear of the body rather than overlapping it, and deliberately so.** Every other shape here
   * touches, which fuses for free at any blend; this pill floats a dozen units above the frame and
   * is held on by the blend alone. It is the one place the effect is doing something a rounded
   * rectangle could not, it is where the neck is visible, and it is what gives the invariant in
   * `script.test.ts` something real to protect. See `gapBetween` and `BLEND`.
   */
  tab: { x: 266, y: 8, w: 152, h: 40 },
  tabRadius: 16,
};

/**
 * The blend, and the same rule the poured bento lives by: two shapes fuse only while it exceeds
 * twice the gap between them. The widest gap in the whole script is the finished frame's pill at
 * 10 units, so anything above 20 fuses — this leaves room for the pour, where the pill is
 * travelling and the margin has to hold on every intermediate frame, not just the two ends.
 */
export const BLEND = 34;

/** The straight-line gap between two boxes, or 0 where they overlap. */
export function gapBetween(a: Box, b: Box): number {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  return Math.hypot(dx, dy);
}

/** 0 before `from`, 1 after `to`, and the fraction between. */
function progress(ms: number, from: number, to: number): number {
  if (to <= from) return 1;
  return Math.max(0, Math.min(1, (ms - from) / (to - from)));
}

/** The house easing: quick out of the gate, long settle. Used for every tween here. */
function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

function mixBox(a: Box, b: Box, t: number): Box {
  return { x: mix(a.x, b.x, t), y: mix(a.y, b.y, t), w: mix(a.w, b.w, t), h: mix(a.h, b.h, t) };
}

type Shape = { body: Box; bodyRadius: number; tab: Box; tabRadius: number };

function mixShape(a: Shape, b: Shape, t: number): Shape {
  return {
    body: mixBox(a.body, b.body, t),
    bodyRadius: mix(a.bodyRadius, b.bodyRadius, t),
    tab: mixBox(a.tab, b.tab, t),
    tabRadius: mix(a.tabRadius, b.tabRadius, t),
  };
}

/** Where the cursor rests while it is typing: just past the last character. */
function caretX(typed: string): number {
  // The design space's own units, measured against the 15px face the bar is set in. Close enough
  // that the pointer sits with the text rather than exactly on it, which is what a person does.
  return BAR.body.x + 26 + typed.length * 7.6;
}

const OFF_STAGE = { x: SPACE.w + 60, y: SPACE.h + 40 };
const SEND_BUTTON = { x: BAR.body.x + BAR.body.w - 34, y: BAR.body.y + BAR.body.h / 2 };

/** How far through a tool call's own life the demo is, and what that makes it. */
function stepState(ms: number, index: number): StepState {
  const born = POUR_IN_END + index * STEP_EVERY;
  if (ms < born) return "pending";
  // The last one is deliberately left running: a turn that has finished every call it will ever
  // make is a finished turn, and this one is meant to still be working when the preview arrives.
  if (index === STEPS.length - 1) return "running";
  return ms < born + STEP_SPINS ? "running" : "done";
}

/**
 * The whole demo at a moment.
 *
 * Time wraps, so a caller can hand it a monotonic clock forever and never think about the loop —
 * and `frameAt(t)` is by construction the same frame as `frameAt(t + LOOP_MS)`, which is what
 * stops the picture jumping when it comes round.
 */
export function frameAt(msIn: number): Frame {
  const ms = ((msIn % LOOP_MS) + LOOP_MS) % LOOP_MS;

  const typedCount =
    ms < ARRIVE_END ? 0 : Math.round(progress(ms, ARRIVE_END, TYPE_END) * SENTENCE.length);
  const typed = SENTENCE.slice(0, typedCount);

  // The shape: a bar, pouring into a panel, pouring into a frame.
  const shape =
    ms < SEND_END
      ? mixShape(BAR, BAR, 0)
      : ms < POUR_IN_END
        ? mixShape(BAR, PANEL, ease(progress(ms, SEND_END, POUR_IN_END)))
        : ms < WORK_END
          ? mixShape(PANEL, PANEL, 0)
          : ms < POUR_OUT_END
            ? mixShape(PANEL, FRAME, ease(progress(ms, WORK_END, POUR_OUT_END)))
            : mixShape(FRAME, FRAME, 0);

  const act: Act =
    ms < ARRIVE_END
      ? "arrive"
      : ms < TYPE_END
        ? "type"
        : ms < SEND_END
          ? "send"
          : ms < POUR_IN_END
            ? "pour-in"
            : ms < WORK_END
              ? "work"
              : ms < POUR_OUT_END
                ? "pour-out"
                : ms < PREVIEW_END
                  ? "preview"
                  : "rest";

  // The lit beat changes on the pours, not on the acts: the copy beside the stage describes what
  // is about to happen, so it should turn over as the shape starts moving towards it.
  const beat: Beat = ms < SEND_END ? 1 : ms < WORK_END ? 2 : 3;

  return {
    act,
    beat,
    ...shape,
    k: BLEND,
    typed,
    // A caret while there is a bar to hold it, blinking once the sentence is finished — a caret
    // that keeps blinking mid-word looks like a dropped frame rather than a cursor.
    caret: ms < SEND_END && (act === "type" || Math.floor(ms / 500) % 2 === 0),
    cursor: cursorAt(ms, act, typed),
    send: pressAt(ms),
    steps: STEPS.map((_, index) => stepState(ms, index)),
    /*
     * The contents hand over *inside* the pour, and the overlap is the point. Faded out at the
     * start and in at the end, the shape spends the middle of every morph as an empty card, which
     * reads as a blank frame rather than as one thing becoming another. The outgoing contents
     * leave quickly and the incoming ones start about half way, while the box is still moving.
     */
    prompt: 1 - progress(ms, SEND_END, SEND_END + 200),
    panel: progress(ms, SEND_END + 380, POUR_IN_END) - progress(ms, WORK_END, WORK_END + 200),
    preview: progress(ms, WORK_END + 380, PREVIEW_END - 600),
  };
}

/** The press, 0 to 1 and back, on the send button. */
function pressAt(ms: number): number {
  if (ms < PRESS_AT || ms > PRESS_AT + PRESS_MS) return 0;
  const t = progress(ms, PRESS_AT, PRESS_AT + PRESS_MS);
  return Math.sin(t * Math.PI);
}

/**
 * Where the pointer is.
 *
 * It arrives from off the bottom-right corner, follows its own typing, crosses to the button,
 * presses, and then leaves the way it came — it is a visitor, and one that stayed on screen
 * through the whole build would read as a stuck graphic rather than as somebody using the thing.
 */
function cursorAt(ms: number, act: Act, typed: string): Frame["cursor"] {
  const press = pressAt(ms);

  if (act === "arrive") {
    const t = ease(progress(ms, 0, ARRIVE_END));
    return {
      x: mix(OFF_STAGE.x, caretX(""), t),
      y: mix(OFF_STAGE.y, BAR.body.y + BAR.body.h / 2 + 12, t),
      press: 0,
      alpha: Math.min(1, t * 2.5),
    };
  }

  if (act === "type") {
    return {
      x: caretX(typed),
      y: BAR.body.y + BAR.body.h / 2 + 12,
      press: 0,
      alpha: 1,
    };
  }

  if (act === "send") {
    // Crossing to the button, arriving a little before the press so the two read as cause and
    // effect rather than as one event.
    const t = ease(progress(ms, TYPE_END, PRESS_AT - 60));
    return {
      x: mix(caretX(typed), SEND_BUTTON.x, t),
      y: mix(BAR.body.y + BAR.body.h / 2 + 12, SEND_BUTTON.y + 10, t),
      press,
      alpha: 1,
    };
  }

  // Everything after the press: leave, and stay gone until the loop comes round.
  const t = ease(progress(ms, SEND_END, SEND_END + 700));
  return {
    x: mix(SEND_BUTTON.x, OFF_STAGE.x, t),
    y: mix(SEND_BUTTON.y + 10, OFF_STAGE.y, t),
    press: 0,
    alpha: 1 - t,
  };
}

/** The frame the stage holds still on when the reader has asked for no motion. */
export const STILL_MS = POUR_IN_END + STEP_EVERY * 2 + 200;
