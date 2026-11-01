/**
 * What one turn has seen of the project's files.
 *
 * It exists for one rule: an existing file is read before it is changed. A model that edits
 * from memory — of an earlier turn, or of what the template usually looks like — writes a
 * confident change against text that is not there, and `write_file` makes it worse by replacing
 * a whole file the model never looked at. Refusing the call costs one `read_file`; allowing it
 * costs whatever the overwritten file held.
 *
 * Per turn, never carried across: between two turns the person, a repair or a command may have
 * changed anything. A file the turn wrote counts as known, because the turn knows exactly what
 * it put there.
 */

import { posix } from "node:path";

export class FileLedger {
  readonly #known = new Set<string>();

  /**
   * The model has read the file this turn — any part of it, since an edit must still match the
   * text exactly — or wrote it.
   */
  remember(path: string): void {
    this.#known.add(normalize(path));
  }

  knows(path: string): boolean {
    return this.#known.has(normalize(path));
  }

  /** A deleted or moved-away file is no longer something the turn can claim to know. */
  forget(path: string): void {
    this.#known.delete(normalize(path));
  }
}

function normalize(path: string): string {
  return posix.normalize(path);
}
