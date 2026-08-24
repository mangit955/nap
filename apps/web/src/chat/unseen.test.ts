import { describe, expect, it } from "vitest";
import { readSeen, type SeenStorage, seamAt, writeSeen } from "./unseen.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const OTHER = "1c8f9f2e-4d3b-4e6c-8f7a-2b3c4d5e6f70";

/** A storage a test controls, and which can be made to refuse — Safari's private mode throws. */
function store(initial: Record<string, string> = {}, refuse = false): SeenStorage {
  const map = new Map(Object.entries(initial));

  return {
    getItem: (key) => {
      if (refuse) throw new Error("denied");
      return map.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (refuse) throw new Error("denied");
      map.set(key, value);
    },
  };
}

describe("the seen cursor", () => {
  it("remembers what one session displayed, apart from every other session", () => {
    const storage = store();

    writeSeen(storage, SESSION, 42);

    expect(readSeen(storage, SESSION)).toBe(42);
    // The cursor is per session as well as per browser: two projects open in two tabs must not
    // hand each other a seam from the wrong transcript.
    expect(readSeen(storage, OTHER)).toBeUndefined();
  });

  it("has no cursor for a session this browser has never opened", () => {
    // Not zero. Nothing seen and nothing to mark are different answers, and only the second
    // means "do not draw a seam" — a first visit has no place it left off.
    expect(readSeen(store(), SESSION)).toBeUndefined();
  });

  it("never moves backwards", () => {
    const storage = store();
    writeSeen(storage, SESSION, 90);

    // A second tab on the same session replays from zero and climbs; letting its early writes
    // land would tell the first tab it had seen ninety fewer events than it has.
    writeSeen(storage, SESSION, 12);

    expect(readSeen(storage, SESSION)).toBe(90);
  });

  it("ignores a cursor that is not a number", () => {
    // Anything unreadable is treated as no cursor at all, which draws no seam. Believing it
    // would put the marker at `NaN` — that is, nowhere, silently.
    expect(readSeen(store({ "nap.seen.0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f": "" }), SESSION)).toBe(
      undefined,
    );
  });

  it("survives a browser that refuses storage", () => {
    const storage = store({}, true);

    expect(() => writeSeen(storage, SESSION, 7)).not.toThrow();
    expect(readSeen(storage, SESSION)).toBeUndefined();
  });
});

describe("where the seam falls", () => {
  const items = [{ key: 1 }, { key: 4 }, { key: 9 }];

  it("marks the first item that arrived entirely after the cursor", () => {
    expect(seamAt(items, 4)).toBe(9);
  });

  it("keeps an item that straddles the cursor above the seam", () => {
    // The folds coalesce: a passage keyed 4 goes on absorbing events 5, 6, 7 as the model
    // writes them. Part of it was displayed, so it is not new — everything *below* the marker
    // has to be wholly unseen or the line is a lie.
    expect(seamAt(items, 6)).toBe(9);
  });

  it("has no seam when everything has been displayed", () => {
    expect(seamAt(items, 9)).toBeUndefined();
    expect(seamAt(items, 40)).toBeUndefined();
  });

  it("has no seam without a cursor", () => {
    // A first visit replays the whole log, and marking all of it new would put the seam above
    // the first thing the user ever said.
    expect(seamAt(items, undefined)).toBeUndefined();
  });

  it("has no seam in an empty transcript", () => {
    expect(seamAt([], 3)).toBeUndefined();
  });
});
