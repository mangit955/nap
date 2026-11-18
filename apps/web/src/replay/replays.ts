/**
 * The replays this deployment ships, by slug.
 *
 * Committed files rather than rows marked as a showcase in the database: a replay has to outlive
 * any one database (the free one production runs on is deleted when its plan lapses), it must be
 * reviewable in a pull request before the public sees it, and reading it must not wake the API at
 * all. Parsed here, on the server, when the page is built, so a visitor's browser receives a log
 * that already passed the contract and spends nothing checking it again.
 */

import { type ReplayRecording, ReplayRecordingSchema } from "./recording.ts";
import readingList from "./recordings/reading-list.json" with { type: "json" };

const RECORDINGS: readonly ReplayRecording[] = [ReplayRecordingSchema.parse(readingList)];

export function replaySlugs(): string[] {
  return RECORDINGS.map((recording) => recording.slug);
}

export function findReplay(slug: string): ReplayRecording | undefined {
  return RECORDINGS.find((recording) => recording.slug === slug);
}
