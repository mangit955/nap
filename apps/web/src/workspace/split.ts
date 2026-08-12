/**
 * Where the divider between the chat and the workbench stands.
 *
 * A split is a preference and a strong one: somebody reading a long tool result wants the
 * transcript wide, and somebody watching their app wants it out of the way. So it is dragged
 * rather than fixed, and remembered rather than reset on every visit.
 *
 * Everything here is arithmetic and a storage passed in, so the whole rule is checkable without
 * mounting anything — the component keeps only the pointer handling.
 */

/** The subset of `Storage` this needs; `window.localStorage` satisfies it. */
export type WidthStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

const KEY = "nap.chat-width";

/** Roughly a third of a laptop window, which is where Bolt's own divider sits. */
export const DEFAULT_CHAT_WIDTH = 440;

/** Narrow enough and the transcript is two words a line; that is not a conversation. */
const MIN_CHAT_WIDTH = 280;

/**
 * The workbench keeps the larger share. The preview is the thing being watched, and a divider
 * that could be pushed to the far edge lets somebody hide it entirely and conclude their app
 * has gone — the same failure the put-away panel exists to prevent.
 */
const MAX_CHAT_FRACTION = 0.6;

export function clampChatWidth(width: number, viewportWidth: number): number {
  const ceiling = viewportWidth * MAX_CHAT_FRACTION;

  // On a window narrower than the floor the two bounds cross, and the ceiling has to win: a
  // width wider than the window would push the workbench off the screen entirely.
  if (ceiling < MIN_CHAT_WIDTH) return Math.max(0, Math.round(ceiling));

  return Math.round(Math.min(Math.max(width, MIN_CHAT_WIDTH), ceiling));
}

/**
 * The stored width, clamped to *this* window.
 *
 * Clamped on the way out rather than only on the way in, because the window is very often a
 * different size than it was when the number was written — a split saved on a wide monitor is a
 * chat column with no room beside it on a laptop.
 */
export function readChatWidth(storage: WidthStorage, viewportWidth: number): number {
  const stored = read(storage);
  if (stored === undefined) return DEFAULT_CHAT_WIDTH;
  return clampChatWidth(stored, viewportWidth);
}

export function writeChatWidth(storage: WidthStorage, width: number): void {
  try {
    storage.setItem(KEY, String(Math.round(width)));
  } catch {
    // A browser that refuses storage still gets to resize its panes; it just forgets.
  }
}

function read(storage: WidthStorage): number | undefined {
  try {
    const raw = storage.getItem(KEY);
    if (raw === null) return undefined;

    const value = Number.parseInt(raw, 10);
    // A `NaN` here would render `grid-template-columns: NaNpx 1fr` and collapse the layout, so
    // anything unreadable is treated as nothing stored at all.
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The width a pointer at this position implies, measured from the shell's own left edge. */
export function chatWidthFrom({
  pointerX,
  leftEdge,
  viewportWidth,
}: {
  pointerX: number;
  /** The shell's left edge in the page, since it does not always start at zero. */
  leftEdge: number;
  viewportWidth: number;
}): number {
  return clampChatWidth(pointerX - leftEdge, viewportWidth);
}
