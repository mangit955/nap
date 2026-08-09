/**
 * Turning a write into the `file.changed` payload.
 *
 * The diff is not for the model — it already knows what it wrote. It is for the person
 * watching the chat pane, and later for anything replaying a session to reconstruct what a
 * turn did. That makes standard unified diff the right format: it is the one every reader,
 * human or tool, already understands.
 */

import type { NapEventOf } from "@nap/shared/events";
import { createPatch } from "diff";

type FileChanged = NapEventOf<"file.changed">["payload"];

/** Lines of surrounding context per hunk. Three is the convention every diff reader expects. */
const CONTEXT_LINES = 3;

/**
 * Describes a write as a change, given what the file held before.
 *
 * `before` is `null` when the file did not exist, which is the only thing separating a
 * creation from a modification — the tools cannot ask the filesystem after the fact.
 */
export function fileChange(
  path: string,
  before: string | null,
  after: string,
): Pick<FileChanged, "changeType" | "diff"> {
  return {
    changeType: before === null ? "created" : "modified",
    diff: createPatch(path, before ?? "", after, undefined, undefined, {
      context: CONTEXT_LINES,
    }),
  };
}
