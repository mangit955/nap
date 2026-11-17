/**
 * What a replay shows at a given point in its log — pure, so every answer is checkable without
 * rendering or waiting.
 */

import type { FileListing } from "@nap/shared/files-protocol";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import type { ReplayRecording } from "./recording.ts";

/**
 * The longest pause a replay keeps between two events.
 *
 * The recorded gaps are kept as they were, because the rhythm of a model thinking, a command
 * printing and a reply streaming is most of what makes the session read as real. A long silence
 * is not: the model writing a whole file arrives as one event after fourteen seconds of nothing,
 * and a visitor watching nothing for fourteen seconds leaves. The bar under the transcript says
 * pauses are shortened, so the clock is not a claim about how fast Nap is; the turn's own
 * "Worked for" still reads the duration the session recorded.
 */
export const MAX_GAP_MS = 3000;

/** When each event is shown, in milliseconds from the start of playback. */
export function playbackOffsets(events: readonly StoredEvent[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  let previous: number | undefined;
  for (const event of events) {
    const at = Date.parse(event.createdAt);
    if (previous !== undefined) offset += Math.min(Math.max(at - previous, 0), MAX_GAP_MS);
    previous = at;
    offsets.push(offset);
  }
  return offsets;
}

/**
 * The project's files as they stood once the event at `seq` had happened: the files the session
 * started from, with every revision announced by then laid over them.
 */
export function filesAt(recording: ReplayRecording, seq: number): ReadonlyMap<string, string> {
  const files = new Map(Object.entries(recording.files));
  for (const revision of recording.revisions)
    if (revision.seq <= seq) files.set(revision.path, revision.contents);
  return files;
}

/** The file tree's answer, from the same files, sorted the way a listing is. */
export function listingAt(recording: ReplayRecording, seq: number): FileListing {
  return { ready: true, files: [...filesAt(recording, seq).keys()].sort(), truncated: false };
}

/**
 * Which build stands in for the preview at `seq`, or `undefined` before the session's preview
 * came up — the pane then says it is starting, as it did at the time.
 */
export function buildAt(recording: ReplayRecording, seq: number) {
  return recording.builds.findLast((build) => build.fromSeq <= seq);
}
