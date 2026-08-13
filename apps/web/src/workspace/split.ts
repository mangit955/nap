/**
 * Where a divider stands.
 *
 * A split is a preference and a strong one: somebody reading a long tool result wants the
 * transcript wide, and somebody watching their app wants it out of the way. So it is dragged
 * rather than fixed, and remembered rather than reset on every visit.
 *
 * Everything here is arithmetic and a storage passed in, so the whole rule is checkable without
 * mounting anything — the component keeps only the pointer handling.
 *
 * **There are two dividers now** — the chat against the workbench, and the file tree against the
 * editor — and they are the same rule with different numbers. So the rule is a factory and each
 * divider is an instance of it. The alternative was a second copy with the constants edited,
 * which is how one of them ends up with a fix the other never got. The bounds genuinely differ:
 * 180px is a readable column of filenames and an unreadable transcript.
 */

/** The subset of `Storage` this needs; `window.localStorage` satisfies it. */
export type WidthStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

export type Split = {
  clamp: (width: number, viewportWidth: number) => number;
  read: (storage: WidthStorage, viewportWidth: number) => number;
  write: (storage: WidthStorage, width: number) => void;
  widthFrom: (position: {
    pointerX: number;
    /** The container's left edge in the page, since it does not always start at zero. */
    leftEdge: number;
    viewportWidth: number;
  }) => number;
};

export function makeSplit({
  key,
  fallback,
  min,
  maxFraction,
}: {
  key: string;
  fallback: number;
  min: number;
  /** The most of the window this pane may take. The other side always keeps the rest. */
  maxFraction: number;
}): Split {
  const clamp = (width: number, viewportWidth: number): number => {
    const ceiling = viewportWidth * maxFraction;

    // On a window narrower than the floor the two bounds cross, and the ceiling has to win: a
    // width wider than the window would push the other pane off the screen entirely.
    if (ceiling < min) return Math.max(0, Math.round(ceiling));

    return Math.round(Math.min(Math.max(width, min), ceiling));
  };

  return {
    clamp,

    /**
     * The stored width, clamped to *this* window.
     *
     * Clamped on the way out rather than only on the way in, because the window is very often a
     * different size than it was when the number was written — a split saved on a wide monitor
     * is a chat column with no room beside it on a laptop.
     */
    read: (storage, viewportWidth) => {
      const stored = readStored(storage, key);
      if (stored === undefined) return fallback;
      return clamp(stored, viewportWidth);
    },

    write: (storage, width) => {
      try {
        storage.setItem(key, String(Math.round(width)));
      } catch {
        // A browser that refuses storage still gets to resize its panes; it just forgets.
      }
    },

    /** The width a pointer at this position implies, measured from the container's left edge. */
    widthFrom: ({ pointerX, leftEdge, viewportWidth }) => clamp(pointerX - leftEdge, viewportWidth),
  };
}

function readStored(storage: WidthStorage, key: string): number | undefined {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return undefined;

    const value = Number.parseInt(raw, 10);
    // A `NaN` here would render `grid-template-columns: NaNpx 1fr` and collapse the layout, so
    // anything unreadable is treated as nothing stored at all.
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Roughly a third of a laptop window, which is where Bolt's own divider sits. */
export const DEFAULT_CHAT_WIDTH = 440;

/**
 * The chat against the workbench.
 *
 * Narrower than 280 and the transcript is two words a line; that is not a conversation. And the
 * workbench keeps the larger share, because the preview is the thing being watched — a divider
 * that could be pushed to the far edge lets somebody hide it entirely and conclude their app has
 * gone, which is the same failure the put-away panel exists to prevent.
 */
export const CHAT_SPLIT = makeSplit({
  key: "nap.chat-width",
  fallback: DEFAULT_CHAT_WIDTH,
  min: 280,
  maxFraction: 0.6,
});

/**
 * The file tree against the editor.
 *
 * Allowed a smaller share than the chat: source is the thing being read here, and a tree wide
 * enough to matter is still only a column of names.
 */
export const TREE_SPLIT = makeSplit({
  key: "nap.tree-width",
  fallback: 240,
  min: 180,
  maxFraction: 0.4,
});

/*
 * The chat divider's four functions under their original names. `useChatWidth` and its tests
 * were written against these, and a rename would be churn in service of nothing.
 */
export const clampChatWidth = CHAT_SPLIT.clamp;
export const readChatWidth = CHAT_SPLIT.read;
export const writeChatWidth = CHAT_SPLIT.write;
export const chatWidthFrom = CHAT_SPLIT.widthFrom;
