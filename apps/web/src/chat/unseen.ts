/**
 * Unseen: the events in a session that this browser has never displayed.
 *
 * Work continues while nobody is watching — a turn runs on a worker behind a queue, and the
 * worker cannot see the socket (docs/adr/0009) — so somebody who closes a laptop and comes back
 * arrives to a transcript that grew without them. This is the arithmetic that says where they
 * left off, against a cursor written down as they watched.
 *
 * **Two cursors, and they must not share a word.** `use-event-stream.ts` keeps a `lastSeq`: the
 * highest sequence received, and where `/ws?seq=N` resumes a dropped connection from. That one is
 * per *connection* and in memory — it survives a socket drop and dies on a page close. The seen
 * cursor here is per *browser* and durable, in `localStorage`, keyed by session. They hold
 * similar-looking numbers for opposite lifetimes, and the day they are both called "seq" is the
 * day somebody persists the replay cursor and a reconnect silently marks an hour of work as read.
 *
 * Deliberately not "away". Away names the user's state, which nothing here can observe; what is
 * computed is a property of the log against a cursor. The user-facing sentence is allowed to
 * differ, the same way `working-state.ts` keeps a verb map apart from the sentence it reads as.
 *
 * A server-side read cursor was considered and rejected: it would survive a device switch, but
 * needs a column, an endpoint and a write per event, and the case this is for is one laptop.
 *
 * Pure, and the storage is passed in, so the whole rule is checkable without a browser — the same
 * shape `split.ts` uses for the divider's remembered width.
 */

/** The subset of `Storage` this needs; `window.localStorage` satisfies it. */
export type SeenStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

/**
 * Namespaced by session, because two projects open in two tabs are two transcripts. `nap.` is the
 * prefix the pane widths and the welcome flag already use.
 */
function key(sessionId: string): string {
  return `nap.seen.${sessionId}`;
}

/**
 * The highest sequence this browser has displayed for the session, or `undefined` if it has never
 * displayed any.
 *
 * **Absent is not zero.** A session with a cursor of zero has been opened and shown nothing; a
 * session with no cursor has never been opened here at all, and only the second means there is no
 * place to mark. Everything unreadable — a refused storage, a value that is not a number — reads
 * as absent, which draws no seam rather than drawing one nowhere.
 */
export function readSeen(storage: SeenStorage, sessionId: string): number | undefined {
  try {
    const raw = storage.getItem(key(sessionId));
    if (raw === null) return undefined;

    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Records that everything up to `seq` has been displayed.
 *
 * **Monotonic, and that is load-bearing.** A second tab on the same session opens its own socket,
 * replays from zero and climbs — so its early writes are lower than what the first tab has already
 * seen, and taking them would hand that tab a seam an hour above where it actually left off.
 */
export function writeSeen(storage: SeenStorage, sessionId: string, seq: number): void {
  const stored = readSeen(storage, sessionId);
  if (stored !== undefined && seq <= stored) return;

  try {
    storage.setItem(key(sessionId), String(seq));
  } catch {
    // A browser that refuses storage still gets a working transcript; it just never marks a seam.
  }
}

/**
 * The key of the first transcript item that is wholly unseen, or `undefined` when there is no
 * seam to draw.
 *
 * Items rather than events, because items are what is on screen — and the rule is *wholly*. The
 * folds coalesce: a passage of the agent's prose keeps the `seq` it opened with and goes on
 * absorbing the events after it, so an item keyed at or below the cursor was already partly
 * displayed. Marking it new would put "you missed this" above a paragraph the reader watched
 * being written. Everything below the marker has to be new or the line is a lie.
 */
export function seamAt(
  items: readonly { key: number }[],
  seen: number | undefined,
): number | undefined {
  if (seen === undefined) return undefined;
  return items.find((item) => item.key > seen)?.key;
}
