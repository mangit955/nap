/**
 * Where the conversation should be scrolled after each render, decided without touching the DOM.
 *
 * Two rules share the box, and this is the whole of how they hand over to each other.
 *
 * **Following.** A running turn writes below the fold, so the box keeps to the bottom, but only
 * for a reader who was at the bottom *before* the new content arrived. Somebody reading the diff
 * from four tool calls ago must not be dragged away each time a build prints a line. "Before" is
 * the height at the end of the previous pass: by the time the next pass runs, the new content is
 * already laid out, and measuring then would find the reader adrift when what moved was the floor.
 *
 * **Anchoring.** A message this tab sends goes to the *top* of the view, and the reply fills in
 * below it. Kept at the bottom instead, the reader's own words scroll away as soon as the reply is
 * longer than they are. So a send arms the anchor, and the first new prompt bubble after it takes
 * it. The bubble might be the optimistic copy or, for a request queued behind a compaction, the
 * log's copy much later. While anchored, the box is put back at that bubble on every pass.
 *
 * Holding a short reply's prompt at the top needs room the content does not have: with three lines
 * under it, the box's furthest scroll leaves the prompt halfway down. So the planner asks for
 * **end space**: just enough empty height after the transcript that the prompt *can* sit at the
 * top. It is computed afresh each pass from where the prompt is and where the content ends, so it
 * shrinks as the reply grows and reaches zero once the reply fills the view; nothing removes it
 * separately. It stays sized for the newest anchored prompt for as long as the pane is mounted, so
 * a turn that folds shorter when it ends keeps its prompt where the reader left it.
 *
 * The anchor lets go in three ways, all taken from T3 Code's timeline:
 *
 *   - **The reader scrolls.** From then on the box is theirs, and following picks up again only
 *     if they return to the end. A scroll is told from the page moving under the reader by asking
 *     two things at once: did the box move from where the last pass left it, *and* did the prompt
 *     move on screen? Either alone is the page. When content above the prompt shrinks (the last
 *     turn's cards go once a new prompt lands), Chrome's scroll anchoring moves the box to keep the
 *     prompt still on screen; Safari has no scroll anchoring, so there the box stays and the
 *     prompt moves. Only a reader moves both. One case moves both without a reader: content below
 *     shrinking clamps the box to a nearer floor. That one is recognised by where it lands.
 *   - **The reply starts working.** Prose reads downward from the prompt, but tool calls are a
 *     live row at the end, and a reader held at the prompt would watch a turn they cannot see.
 *     From the first call on, the box follows the end. Thanks to the end space, the end and the
 *     prompt are the same place until the work outgrows the view.
 *   - **A message is sent into the running turn.** It is drawn at the end, and the reader who sent
 *     it has to see it land.
 *
 * Messages from anywhere else do not anchor: another tab's prompt appearing is not something this
 * reader asked to look at, and following already brings it into view for a reader at the end.
 */

/** How far from the bottom still counts as watching. A trackpad's inertia leaves a box short. */
export const NEAR_BOTTOM = 64;

/** How much of what came before stays visible above an anchored prompt, so it reads as a turn. */
export const ANCHOR_MARGIN = 24;

/**
 * How far the box may drift from where a pass left it before that counts as the reader's doing.
 * Browsers round fractional offsets, so exact equality would release the anchor on its own.
 */
const MOVED = 2;

type Hold =
  | { mode: "follow" }
  /** A send is on its way. It anchors to the first prompt beyond the `after`-th. */
  | { mode: "armed"; after: number }
  | { mode: "anchored" };

export type ScrollMemory = {
  hold: Hold;
  /** Which prompt, by position among the drawn prompts, the end space is kept for. */
  room: number | undefined;
  /** How many prompts were drawn at the end of the last pass. */
  prompts: number;
  sending: boolean;
  steering: boolean;
  /** Where the anchored prompt was, in scroll coordinates, at the last pass. */
  anchorTop: number | undefined;
  /**
   * Where the box was left at the end of the last pass, how tall it was then, and how far below
   * the box's top edge the anchored prompt was drawn.
   */
  left: { top: number; height: number; onScreen: number | undefined } | undefined;
};

export const FRESH: ScrollMemory = {
  hold: { mode: "follow" },
  room: undefined,
  prompts: 0,
  sending: false,
  steering: false,
  anchorTop: undefined,
  left: undefined,
};

export type ScrollReading = {
  /** The top of each prompt bubble drawn, in the box's scroll coordinates, oldest first. */
  promptTops: readonly number[];
  /** Where the content ends, padding included and end space excluded. */
  contentEnd: number;
  clientHeight: number;
  scrollTop: number;
  /** How far the box can scroll as it stands, before this pass changes the end space. */
  bottom: number;
  /** A message from this tab that opens a turn is on its way, or queued, and not in the log yet. */
  sending: boolean;
  /** A message from this tab sent into the running turn is on its way. */
  steering: boolean;
  /** The newest response has started working: a tool call, reasoning or a file change. */
  working: boolean;
};

export type ScrollPlan = {
  memory: ScrollMemory;
  /** The end space to leave after the transcript, in pixels. */
  space: number;
  /**
   * Where to put the box, once the end space is in place: the bottom, an offset (clamped by the
   * caller to what the box can scroll), or nowhere.
   */
  scroll: "bottom" | number | undefined;
};

export function planScroll(memory: ScrollMemory, now: ScrollReading): ScrollPlan {
  const count = now.promptTops.length;
  let hold = memory.hold;
  let room = memory.room;
  let toBottom = false;

  if (now.sending && !memory.sending) hold = { mode: "armed", after: memory.prompts };
  if (hold.mode === "armed") {
    if (count > hold.after) {
      hold = { mode: "anchored" };
      room = count - 1;
    } else if (!now.sending) {
      // Refused, or withdrawn: no prompt is coming.
      hold = { mode: "follow" };
    }
  }

  if (now.steering && !memory.steering) {
    hold = { mode: "follow" };
    toBottom = true;
  }

  // The prompt the anchor was kept for is gone without the log's copy taking its place: the send
  // was refused after its bubble was drawn, or it was a command such as `/compact` that the log
  // never records as a message. Holding on by position would land on the prompt before it.
  if (room !== undefined && room >= count) {
    room = undefined;
    if (hold.mode === "anchored") hold = { mode: "follow" };
  }

  const anchorTop = room === undefined ? undefined : now.promptTops[room];

  // A pass that has only just anchored has nothing of its own to compare against: the box is
  // wherever following left it.
  if (hold.mode === "anchored" && memory.hold.mode === "anchored") {
    if (readerMoved(memory, now, anchorTop)) hold = { mode: "follow" };
    else if (now.working) {
      hold = { mode: "follow" };
      toBottom = true;
    }
  }

  const target = anchorTop === undefined ? undefined : Math.max(0, anchorTop - ANCHOR_MARGIN);
  const space = target === undefined ? 0 : Math.max(0, target + now.clientHeight - now.contentEnd);

  let scroll: ScrollPlan["scroll"];
  if (hold.mode === "anchored" && target !== undefined) scroll = target;
  else if (toBottom) scroll = "bottom";
  else {
    // Measured against the height the reader was last looking at. See the header.
    const watching =
      memory.left === undefined ||
      memory.left.height - now.scrollTop - now.clientHeight <= NEAR_BOTTOM;
    scroll = watching ? "bottom" : undefined;
  }

  return {
    memory: {
      hold,
      room,
      prompts: count,
      sending: now.sending,
      steering: now.steering,
      anchorTop,
      left: memory.left,
    },
    space,
    scroll,
  };
}

/** What the caller records once it has placed the box: where it is, and how tall it now is. */
export function leftAt(memory: ScrollMemory, top: number, height: number): ScrollMemory {
  const onScreen = memory.anchorTop === undefined ? undefined : memory.anchorTop - top;
  return { ...memory, left: { top, height, onScreen } };
}

/** Whether the reader scrolled since the last pass, rather than the page moving. See the header. */
function readerMoved(
  memory: ScrollMemory,
  now: ScrollReading,
  anchorTop: number | undefined,
): boolean {
  const left = memory.left;
  if (left === undefined) return false;
  const boxMoved = Math.abs(now.scrollTop - left.top) > MOVED;
  const promptMoved =
    left.onScreen === undefined ||
    anchorTop === undefined ||
    Math.abs(anchorTop - now.scrollTop - left.onScreen) > MOVED;
  // Pulled up to a floor that came up to meet it. A reader scrolling up stops above the floor.
  const clamped = now.scrollTop < left.top && now.scrollTop >= now.bottom - MOVED;
  return boxMoved && promptMoved && !clamped;
}
