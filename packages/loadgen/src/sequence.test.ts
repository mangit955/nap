import { describe, expect, it } from "vitest";
import { checkSequence } from "./sequence.ts";

describe("checkSequence", () => {
  it("finds nothing wrong with a contiguous run", () => {
    expect(checkSequence([1, 2, 3, 4])).toEqual({ gaps: [], duplicates: [] });
  });

  it("names every seq that never arrived", () => {
    expect(checkSequence([1, 2, 5])).toEqual({ gaps: [3, 4], duplicates: [] });
  });

  it("names every seq that arrived twice", () => {
    expect(checkSequence([1, 2, 2, 3, 3])).toEqual({ gaps: [], duplicates: [2, 3] });
  });

  it("reports a duplicate once however many times it repeats", () => {
    expect(checkSequence([1, 1, 1]).duplicates).toEqual([1]);
  });

  it("measures the gap from where the client rejoined, not from one", () => {
    // A reconnect at seq 10 replays 11 onwards; 1..10 are not missing, they were already seen.
    expect(checkSequence([11, 12, 13], 10)).toEqual({ gaps: [], duplicates: [] });
    expect(checkSequence([12, 13], 10)).toEqual({ gaps: [11], duplicates: [] });
  });

  it("counts an event the server should not have replayed as a duplicate", () => {
    // Reconnecting at seq 10 and being sent 10 again is the failure a `&seq=` cursor exists to
    // prevent, and it is not a gap — so it has to land in the other bucket to be seen at all.
    expect(checkSequence([10, 11], 10)).toEqual({ gaps: [], duplicates: [10] });
  });

  it("has nothing to say about an empty stream", () => {
    expect(checkSequence([])).toEqual({ gaps: [], duplicates: [] });
  });

  it("does not assume arrival order", () => {
    expect(checkSequence([3, 1, 2])).toEqual({ gaps: [], duplicates: [] });
  });
});
