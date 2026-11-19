import { describe, expect, it } from "vitest";
import {
  ANCHOR_MARGIN,
  FRESH,
  leftAt,
  planScroll,
  type ScrollMemory,
  type ScrollReading,
} from "./transcript-scroll.ts";

/**
 * Where the conversation goes after each render.
 *
 * jsdom lays nothing out, so these drive the planner with the numbers a browser would measure, and
 * play the box themselves: a `Box` keeps a content height and a scroll offset, applies each plan the
 * way the hook does, and clamps the offset the way a browser does. Each case runs the real sequence
 * — mount, send, stream, scroll — because every rule here is about what changed since the last pass.
 */

const VIEW = 600;

class Box {
  memory: ScrollMemory = FRESH;
  scrollTop = 0;
  space = 0;
  contentEnd: number;
  prompts: number[];
  sending = false;
  steering = false;
  working = false;

  constructor(contentEnd: number, prompts: number[] = []) {
    this.contentEnd = contentEnd;
    this.prompts = prompts;
  }

  get bottom() {
    return Math.max(0, this.contentEnd + this.space - VIEW);
  }

  pass(
    change: Partial<Pick<Box, "contentEnd" | "prompts" | "sending" | "steering" | "working">> = {},
  ) {
    Object.assign(this, change);
    const reading: ScrollReading = {
      promptTops: this.prompts,
      contentEnd: this.contentEnd,
      clientHeight: VIEW,
      scrollTop: this.scrollTop,
      bottom: this.bottom,
      sending: this.sending,
      steering: this.steering,
      working: this.working,
    };
    const plan = planScroll(this.memory, reading);
    this.space = plan.space;
    if (plan.scroll === "bottom") this.scrollTop = this.bottom;
    else if (plan.scroll !== undefined) this.scrollTop = Math.min(this.bottom, plan.scroll);
    this.memory = leftAt(plan.memory, this.scrollTop, Math.max(VIEW, this.contentEnd + this.space));
    return this;
  }

  /** The reader moves the box, which a browser clamps to what it can scroll. */
  scrollTo(top: number) {
    this.scrollTop = Math.max(0, Math.min(this.bottom, top));
  }
}

/** A project with two earlier turns, opened and settled at the bottom. */
function opened() {
  return new Box(2000, [100, 900]).pass();
}

describe("a message sent from this tab", () => {
  it("goes to the top of the view, not the bottom", () => {
    const box = opened();
    expect(box.scrollTop).toBe(1400);

    // The optimistic bubble is drawn in the same render the send starts in.
    box.pass({ sending: true, prompts: [100, 900, 2000], contentEnd: 2100 });

    expect(box.scrollTop).toBe(2000 - ANCHOR_MARGIN);
  });

  it("stays at the top while the reply grows below it", () => {
    const box = opened().pass({ sending: true, prompts: [100, 900, 2000], contentEnd: 2100 });

    // The log's copy replaces the optimistic one, a few pixels lower, and prose streams in.
    box.pass({ sending: false, prompts: [100, 900, 2004], contentEnd: 2300 });
    box.pass({ contentEnd: 2900 });
    box.pass({ contentEnd: 3400 });

    expect(box.scrollTop).toBe(2004 - ANCHOR_MARGIN);
  });

  it("keeps end space under a short reply so the message can sit at the top, and none once the reply fills the view", () => {
    const box = opened().pass({ sending: true, prompts: [100, 900, 2000], contentEnd: 2100 });
    const target = 2000 - ANCHOR_MARGIN;

    // A hundred pixels of content under the prompt: the box could scroll only to 1500 without help.
    expect(box.space).toBe(target + VIEW - 2100);
    expect(box.scrollTop).toBe(target);

    box.pass({ sending: false, contentEnd: 2400 });
    expect(box.space).toBe(target + VIEW - 2400);

    // The reply now reaches the bottom of the view by itself.
    box.pass({ contentEnd: target + VIEW + 1 });
    expect(box.space).toBe(0);
    expect(box.scrollTop).toBe(target);
  });

  it("is left where the reader scrolls it mid-reply", () => {
    const box = opened().pass({ sending: true, prompts: [100, 900, 2000], contentEnd: 2100 });
    box.pass({ sending: false, contentEnd: 2400 });

    box.scrollTo(1200);
    box.pass({ contentEnd: 2600 });
    box.pass({ contentEnd: 2800 });

    expect(box.scrollTop).toBe(1200);
  });

  it("follows the end once the reply starts working", () => {
    // Prose reads downward from the prompt; a tool call is a live row at the end.
    const box = opened().pass({ sending: true, prompts: [100, 900, 2000], contentEnd: 2100 });
    box.pass({ sending: false, contentEnd: 2900 });
    expect(box.scrollTop).toBe(2000 - ANCHOR_MARGIN);

    box.pass({ working: true, contentEnd: 3000 });
    expect(box.scrollTop).toBe(3000 - VIEW);

    box.pass({ contentEnd: 3500 });
    expect(box.scrollTop).toBe(3500 - VIEW);
  });

  it("keeps the message at the top after work starts, while the work still fits under it", () => {
    // The end space makes the end and the prompt the same place until the work outgrows the view.
    const box = opened().pass({ sending: true, prompts: [100, 900, 2000], contentEnd: 2100 });
    box.pass({ sending: false, working: true, contentEnd: 2200 });

    expect(box.scrollTop).toBe(2000 - ANCHOR_MARGIN);
  });

  it("goes nowhere when the send is refused", () => {
    const box = opened();
    box.scrollTo(400);
    box.pass({ sending: true });
    box.pass({ sending: false });

    expect(box.scrollTop).toBe(400);
    expect(box.space).toBe(0);
  });

  it("anchors a request queued behind a compaction when its prompt is finally drawn", () => {
    // Queued, the request waits in the composer and draws no bubble in the transcript.
    const box = opened().pass({ sending: true, contentEnd: 2200 });
    expect(box.scrollTop).toBe(2200 - VIEW);

    box.pass({ sending: false, prompts: [100, 900, 2300], contentEnd: 2400 });
    expect(box.scrollTop).toBe(2300 - ANCHOR_MARGIN);
  });

  it("anchors a brand-new project's first prompt, drawn from the first frame", () => {
    const box = new Box(300, [24]).pass({ sending: true });

    expect(box.scrollTop).toBe(0);
    expect(box.space).toBe(0 + VIEW - 300);
  });

  it("anchors the next message sent, not the first one", () => {
    const box = opened().pass({ sending: true, prompts: [100, 900, 2000], contentEnd: 2100 });
    box.pass({ sending: false, contentEnd: 2400 });

    box.pass({ sending: true, prompts: [100, 900, 2000, 2500], contentEnd: 2600 });

    expect(box.scrollTop).toBe(2500 - ANCHOR_MARGIN);
    expect(box.space).toBe(2500 - ANCHOR_MARGIN + VIEW - 2600);
  });
});

/**
 * The page moving under a reader who did nothing must not count as the reader scrolling. Each of
 * these let the anchor go in a real browser before `readerMoved` asked two questions instead of one.
 */
describe("the page moving under an anchored prompt", () => {
  /** Content above the prompt shrinks: the last turn's cards go once the new prompt lands. */
  function shrinkAbove(box: Box, by: number, scrollAnchoring: boolean) {
    box.prompts = box.prompts.map((top, index) => (index === 0 ? top : top - by));
    box.contentEnd -= by;
    if (scrollAnchoring) box.scrollTop -= by;
  }

  function anchored() {
    return opened().pass({ sending: true, prompts: [100, 900, 2000], contentEnd: 2100 });
  }

  /** Anchored under a reply longer than the view, so the box is nowhere near its floor. */
  function anchoredOverLongReply() {
    return anchored().pass({ contentEnd: 3200 });
  }

  it("holds when Chrome's scroll anchoring moves the box to keep the prompt still", () => {
    const box = anchoredOverLongReply();
    shrinkAbove(box, 179, true);
    box.pass({ sending: false });
    expect(box.scrollTop).toBe(2000 - 179 - ANCHOR_MARGIN);

    // That position is where a released box would have stayed too. What tells them apart is that
    // a held anchor still follows the prompt the next time the page moves.
    shrinkAbove(box, 50, false);
    box.pass({ contentEnd: box.contentEnd + 200 });
    expect(box.scrollTop).toBe(2000 - 179 - 50 - ANCHOR_MARGIN);
  });

  it("holds when a browser without scroll anchoring leaves the box and the prompt moves", () => {
    const box = anchoredOverLongReply();
    shrinkAbove(box, 179, false);
    box.pass({ sending: false });
    box.pass({ contentEnd: box.contentEnd + 200 });

    expect(box.scrollTop).toBe(2000 - 179 - ANCHOR_MARGIN);
  });

  it("holds when content below shrinks and the box is clamped to a nearer floor", () => {
    const box = anchored().pass({ sending: false, contentEnd: 2500 });
    const target = 2000 - ANCHOR_MARGIN;

    // The browser clamps at once; the end space catches up only on the next pass.
    box.contentEnd = 2200;
    box.scrollTo(box.scrollTop);
    expect(box.scrollTop).toBeLessThan(target);
    box.pass();
    box.pass({ contentEnd: 2300 });

    expect(box.scrollTop).toBe(target);
  });
});

describe("a message sent into the running turn", () => {
  it("brings the end into view, where it is drawn", () => {
    const box = opened().pass({ sending: true, prompts: [100, 900, 2000], contentEnd: 2100 });
    box.pass({ sending: false, contentEnd: 3000 });

    box.pass({ steering: true, contentEnd: 3100 });

    expect(box.scrollTop).toBe(3100 - VIEW);
  });
});

describe("following a turn nobody here sent", () => {
  it("opens a project at its newest event", () => {
    expect(opened().scrollTop).toBe(1400);
  });

  it("keeps a reader at the bottom there", () => {
    expect(opened().pass({ contentEnd: 2300 }).scrollTop).toBe(1700);
  });

  it("counts a reader a little way off the bottom as still watching", () => {
    const box = opened();
    box.scrollTo(1350);
    expect(box.pass({ contentEnd: 2300 }).scrollTop).toBe(1700);
  });

  it("leaves a reader who scrolled up alone", () => {
    const box = opened();
    box.scrollTo(300);
    expect(box.pass({ contentEnd: 2300 }).scrollTop).toBe(300);
  });

  it("does not anchor a prompt another tab sent", () => {
    const box = opened().pass({ prompts: [100, 900, 2000], contentEnd: 2100 });

    expect(box.scrollTop).toBe(2100 - VIEW);
    expect(box.space).toBe(0);
  });
});
