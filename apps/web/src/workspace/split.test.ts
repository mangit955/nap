import { describe, expect, it } from "vitest";
import {
  chatWidthFrom,
  clampChatWidth,
  DEFAULT_CHAT_WIDTH,
  readChatWidth,
  writeChatWidth,
} from "./split.ts";

/**
 * Where the divider between the chat and the workbench may stand, and how that survives a
 * reload. Pure arithmetic and a storage passed in, so none of it needs a DOM.
 */

/** The subset of `Storage` the split uses, as a map a test can read back. */
function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("where the divider may stand", () => {
  it("keeps the chat readable, however far left it is dragged", () => {
    // A column narrower than this is a word or two per line, which is not a transcript.
    expect(clampChatWidth(40, 1440)).toBeGreaterThanOrEqual(280);
  });

  it("leaves the workbench the larger half's worth of room", () => {
    // The preview is what the user is watching. A divider that could be pushed to the far edge
    // would let somebody hide it entirely and conclude the app had gone.
    expect(clampChatWidth(2_000, 1440)).toBeLessThanOrEqual(1440 * 0.6);
  });

  it("passes a sensible width through untouched", () => {
    expect(clampChatWidth(460, 1440)).toBe(460);
  });

  it("still gives an answer on a window narrower than the floor", () => {
    // A phone-width viewport cannot satisfy both bounds; the result must be inside the window
    // rather than a number that pushes the workbench off it.
    expect(clampChatWidth(400, 320)).toBeLessThanOrEqual(320);
  });
});

describe("remembering it", () => {
  it("reads back what was written", () => {
    const store = storage();

    writeChatWidth(store, 512);

    expect(readChatWidth(store, 1440)).toBe(512);
  });

  it("falls back to the default when nothing has been stored", () => {
    expect(readChatWidth(storage(), 1440)).toBe(DEFAULT_CHAT_WIDTH);
  });

  it("ignores a stored value that is not a width", () => {
    // Another tab, another version, or somebody with the console open. A NaN here would render
    // a grid column of `NaNpx`, which collapses the whole layout.
    expect(readChatWidth(storage({ "nap.chat-width": "wide please" }), 1440)).toBe(
      DEFAULT_CHAT_WIDTH,
    );
  });

  it("clamps what it read, because the window may be a different size now", () => {
    expect(readChatWidth(storage({ "nap.chat-width": "1200" }), 1440)).toBeLessThanOrEqual(
      1440 * 0.6,
    );
  });

  it("survives a browser that refuses storage entirely", () => {
    // Private mode throws on access rather than returning null.
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };

    expect(readChatWidth(hostile, 1440)).toBe(DEFAULT_CHAT_WIDTH);
    expect(() => writeChatWidth(hostile, 500)).not.toThrow();
  });
});

describe("dragging", () => {
  it("makes the chat as wide as the pointer is far from the left edge", () => {
    expect(chatWidthFrom({ pointerX: 500, leftEdge: 0, viewportWidth: 1440 })).toBe(500);
  });

  it("measures from the panel's own left edge, not the window's", () => {
    // The shell does not start at x=0 in every layout, and a divider that ignored the offset
    // would jump the moment it was grabbed.
    expect(chatWidthFrom({ pointerX: 500, leftEdge: 100, viewportWidth: 1440 })).toBe(400);
  });

  it("is clamped like everything else", () => {
    expect(
      chatWidthFrom({ pointerX: 20, leftEdge: 0, viewportWidth: 1440 }),
    ).toBeGreaterThanOrEqual(280);
  });
});
