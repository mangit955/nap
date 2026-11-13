/**
 * What one turn has seen of the project's files.
 *
 * It exists for one rule: **nothing replaces text the turn has neither seen nor matched.** A
 * model writing from memory — of an earlier turn, or of what the template usually looks like — is
 * confidently wrong about a file the person, a repair or a command changed since. What guards against that depends
 * on how much of the file a call replaces:
 *
 * - `write_file` replaces all of it, so an existing file must be known. Refusing costs one
 *   `read_file`; allowing it costs whatever the file held.
 * - `edit_file` replaces only `old_string`, which must be in the file *now*, byte for byte, exactly
 *   once, and refuses files that cannot round-trip through UTF-8 without changing other bytes.
 *   That match is the guard, and it needs no read: text from a stale memory is not there and
 *   the edit is refused with the advice to read. Demanding a read as well would cost a follow-up
 *   turn a full-context round trip before its first edit and add nothing — the gate never proved
 *   the model saw the edited lines, since reading any part of a file counts.
 * - `replace_all` changes every occurrence, and how many there are now is exactly what an unread
 *   file can have changed — so it needs the file known.
 * - `apply_patch` updates by context, like an edit, and needs no read either. Its deletions are not
 *   gated: the command guard lets `rm` remove any project file, and a command reports no
 *   `file.changed`, so a gate here would only steer deletions to the one path nobody sees.
 *
 * Known means read this turn, or written whole by it: created, or overwritten after a read. An
 * edit or a patch hunk proves only the lines it matched, so it never makes an unread file known.
 * Per turn, never carried across — not even for a file whose bytes are what the turn last saw. A
 * finished turn's reads and large arguments are emptied from every later context (`makeStale` in
 * the context engine), so an earlier turn's knowledge is no longer in front of the model, and a
 * ledger that remembered it would let `write_file` overwrite a file the model can no longer see.
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
