/**
 * Asserting on the shape of an event stream.
 *
 * Ordering is most of what an event test can honestly claim: model prose is not a contract,
 * but "the user's message was logged, then the turn opened, then it completed" is. Comparing
 * the whole list of types at once — rather than indexing into it — means a failure prints
 * both sequences, so the reader sees *what happened* instead of which position disagreed.
 *
 * Takes anything with a `type`, so it works on events on their way in and on events read
 * back out of the store.
 */

import type { NapEventType } from "@nap/shared/events";

export function expectEventSequence(
  events: readonly { type: NapEventType }[],
  expected: readonly NapEventType[],
): void {
  const actual = events.map((event) => event.type);

  if (actual.length === expected.length && actual.every((type, i) => type === expected[i])) {
    return;
  }

  throw new Error(
    `event sequence did not match.\n  expected: ${format(expected)}\n  actual:   ${format(actual)}`,
  );
}

function format(types: readonly NapEventType[]): string {
  return types.length === 0 ? "(none)" : types.join(" → ");
}
