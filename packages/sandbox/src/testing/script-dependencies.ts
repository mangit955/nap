/**
 * The commands `dependency-cache.ts` sends, and the answers a real sandbox would give them.
 *
 * Kept beside the module's own patterns for the reason `script-git.ts` is: a test above this
 * package that reopens a project has to answer them, and several copies of the same regexes drift.
 */

import { DEPENDENCY_CACHEABLE_LINE, DEPENDENCY_SCRATCH } from "../dependency-cache.ts";
import type { InMemorySandboxManager, ScriptedExecResponse } from "./in-memory-sandbox-manager.ts";

export const INSTALL_COMMAND = /bun install/;
export const ARCHIVE_COMMAND = /tar -czf/;
export const EXTRACT_COMMAND = /tar -xzf/;
/** The archive's clean-up, spelled differently from anything the archive command itself runs. */
export const DISCARD_COMMAND = /rm -f -- /;

/** Where `stageDependencyArchive` leaves an archive, and `archiveDependencies` reads one back from. */
export const INCOMING_ARCHIVE = `${DEPENDENCY_SCRATCH}/incoming.tar.gz`;
export const OUTGOING_ARCHIVE = `${DEPENDENCY_SCRATCH}/outgoing.tar.gz`;

/** What `archiveDependencies` reads back. Not a real tarball: nothing in a fake opens one. */
export const FAKE_DEPENDENCY_ARCHIVE = new TextEncoder().encode("gzipped-node-modules");

/** An install that succeeded, and whose result may or may not be cached. */
export function installedWith(cacheable = true): ScriptedExecResponse {
  return {
    exitCode: 0,
    stdout: `Checked 42 installs\n${cacheable ? `${DEPENDENCY_CACHEABLE_LINE}\n` : ""}`,
  };
}

/** An archive command that packed `bytes`: their size on stdout, and the file left to read. */
export function archived(bytes: Uint8Array = FAKE_DEPENDENCY_ARCHIVE): ScriptedExecResponse {
  return { exitCode: 0, stdout: `${bytes.length}\n`, writes: { [OUTGOING_ARCHIVE]: bytes } };
}

/** Every dependency command answered as a healthy sandbox would. */
export function scriptDependencies(
  manager: InMemorySandboxManager,
  cacheable = true,
): InMemorySandboxManager {
  return manager
    .script(INSTALL_COMMAND, installedWith(cacheable))
    .script(ARCHIVE_COMMAND, archived())
    .script(DISCARD_COMMAND, { exitCode: 0 })
    .script(EXTRACT_COMMAND, { exitCode: 0 });
}
