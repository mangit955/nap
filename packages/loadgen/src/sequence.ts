/**
 * Whether a client saw the whole log, exactly once.
 *
 * The two counters `docs/scaling-design.md` §23 says must be zero — `event_seq_gaps` and
 * `event_duplicates` — are the ones that decide whether fanout is correct, and they are the
 * ones a reconnect is most likely to break. So the arithmetic behind them lives here, apart
 * from any socket: given the sequence numbers a client received and the cursor it rejoined at,
 * say what is missing and what came twice.
 *
 * Arrival order is deliberately not asserted on. The store appends and then fans out, so a
 * client can legitimately see a replayed event after a live one during catch-up; what it must
 * never see is a hole or a repeat.
 */

export type SequenceCheck = {
  /** Sequence numbers the client should have received and did not, ascending. */
  gaps: number[];
  /** Sequence numbers the client received more than once, each named once, ascending. */
  duplicates: number[];
};

/**
 * @param seqs Every `seq` this client received, in whatever order they arrived.
 * @param afterSeq The cursor the client connected with. Everything at or below it was already
 *   seen, so receiving it again is a duplicate rather than an extra.
 */
export function checkSequence(seqs: readonly number[], afterSeq = 0): SequenceCheck {
  const seen = new Set<number>();
  const duplicates = new Set<number>();

  for (const seq of seqs) {
    // At or below the cursor means the server replayed something the client already had.
    if (seq <= afterSeq || seen.has(seq)) duplicates.add(seq);
    seen.add(seq);
  }

  const gaps: number[] = [];
  const highest = seqs.length === 0 ? afterSeq : Math.max(...seqs);
  for (let seq = afterSeq + 1; seq < highest; seq += 1) {
    if (!seen.has(seq)) gaps.push(seq);
  }

  return { gaps, duplicates: [...duplicates].sort((a, b) => a - b) };
}
