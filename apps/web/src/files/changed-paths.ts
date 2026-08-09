/**
 * Which files this session's turns have touched.
 *
 * Marking them in the tree is what turns a directory listing into a report: the interesting
 * thing about a project the moment a turn ends is not what is in it, but what just moved.
 *
 * The one subtlety is the form of a path. `file.changed` carries whatever the tool was given,
 * which is absolute, while the file endpoints speak in project-relative paths — so the two
 * sets never intersect unless something puts them in the same shape. `toProjectPath` is that
 * something, and it lives in the protocol module because the mismatch is a property of the
 * boundary rather than of this component.
 */

import { toProjectPath } from "@nap/shared/files-protocol";
import type { StoredEvent } from "@nap/shared/ports/event-store";

/**
 * Files that exist and changed. A deletion is left out: the file is already gone from the
 * listing, so there is no node to mark, and highlighting the folder it used to be in would
 * point at something that is no longer wrong.
 */
export function changedPaths(events: readonly StoredEvent[]): Set<string> {
  const paths = new Set<string>();

  for (const event of events) {
    if (event.type !== "file.changed") continue;
    if (event.payload.changeType === "deleted") continue;
    paths.add(toProjectPath(event.payload.path));
  }

  return paths;
}

/**
 * How many files have changed so far — including deletions, which do not get marked but do
 * make the listing wrong. It is a number rather than a boolean so that "another file changed"
 * is observable, which is what makes it usable as a reason to ask the server again.
 */
export function changeCount(events: readonly StoredEvent[]): number {
  return events.filter((event) => event.type === "file.changed").length;
}
