import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useAfterReplay } from "./after-replay.ts";

const S1 = "5509bb3b-712e-4190-bc00-ed964702c8d1";
const S2 = "96f33335-43e1-4ecb-b0b5-b02fcfa7e7e9";

it("stays 0 through the replay and moves only for what came after it", () => {
  const seen: number[] = [];
  const { rerender } = renderHook(
    ({ seq, replayed, session }) => {
      const value = useAfterReplay(seq, replayed, session);
      seen.push(value);
      return value;
    },
    { initialProps: { seq: 0, replayed: false, session: S1 as string | undefined } },
  );
  rerender({ seq: 12, replayed: true, session: S1 });
  rerender({ seq: 12, replayed: true, session: S1 });
  rerender({ seq: 15, replayed: true, session: S1 });
  // A render that saw the replay's own notice as news would have read the record again.
  expect(seen.slice(0, -1).every((value) => value === 0)).toBe(true);
  expect(seen.at(-1)).toBe(15);

  // Another session is another log, measured from its own replay.
  rerender({ seq: 15, replayed: false, session: S2 });
  rerender({ seq: 30, replayed: true, session: S2 });
  expect(seen.at(-1)).toBe(0);
  rerender({ seq: 31, replayed: true, session: S2 });
  expect(seen.at(-1)).toBe(31);
});
