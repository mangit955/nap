/**
 * The commands `dependency-cache.ts` sends, and the answers a real sandbox would give them.
 *
 * Kept beside the module's own patterns for the reason `script-git.ts` is: a test above this
 * package that reopens a project has to answer them, and several copies of the same regexes drift.
 */

import {
  DEPENDENCY_CACHE_LINE,
  DEPENDENCY_CHANGED_LINE,
  DEPENDENCY_SCRATCH,
  type DependencyArchiveKind,
} from "../dependency-cache.ts";
import type { InMemorySandboxManager, ScriptedExecResponse } from "./in-memory-sandbox-manager.ts";

/** Either install: a fake answering this answers the offline one too, unless that has its own. */
export const INSTALL_COMMAND = /bun install/;
export const OFFLINE_INSTALL_COMMAND = /bun install --offline/;
/** `node_modules`, packed and extracted. */
export const ARCHIVE_COMMAND = /tar -czf/;
export const EXTRACT_COMMAND = /tar -xzf/;
/** Bun's package cache, packed and extracted: spelled apart from the two above for these patterns. */
export const PACKAGE_ARCHIVE_COMMAND = /tar -cz -f/;
export const PACKAGE_EXTRACT_COMMAND = /tar -xz -f/;
/** The archive's clean-up, spelled differently from anything the archive command itself runs. */
export const DISCARD_COMMAND = /rm -f -- /;

/** Where `stageDependencyArchive` leaves an archive, and `archiveDependencies` reads one back from. */
export const INCOMING_ARCHIVE = `${DEPENDENCY_SCRATCH}/incoming.tar.gz`;
export const OUTGOING_ARCHIVE = `${DEPENDENCY_SCRATCH}/outgoing.tar.gz`;

/** What `archiveDependencies` reads back. Not a real tarball: nothing in a fake opens one. */
export const FAKE_DEPENDENCY_ARCHIVE = new TextEncoder().encode("gzipped-node-modules");

/**
 * An install that succeeded: the archive that describes it, if any, and the committed files it
 * changed, as the install command prints them.
 */
export function installedWith(
  cache: DependencyArchiveKind | null = "node_modules",
  changed: readonly string[] = [],
): ScriptedExecResponse {
  const lines = [
    "Checked 42 installs",
    ...changed.map((path) => `${DEPENDENCY_CHANGED_LINE}  M ${path}`),
    ...(cache === null ? [] : [`${DEPENDENCY_CACHE_LINE} ${cache}`]),
  ];
  return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
}

/** An archive command that packed `bytes`: their size on stdout, and the file left to read. */
export function archived(bytes: Uint8Array = FAKE_DEPENDENCY_ARCHIVE): ScriptedExecResponse {
  return { exitCode: 0, stdout: `${bytes.length}\n`, writes: { [OUTGOING_ARCHIVE]: bytes } };
}

/** Every dependency command answered as a healthy sandbox would, the install saying `cache`. */
export function scriptDependencies(
  manager: InMemorySandboxManager,
  cache: DependencyArchiveKind | null = "node_modules",
): InMemorySandboxManager {
  return manager
    .script(INSTALL_COMMAND, installedWith(cache))
    .script(ARCHIVE_COMMAND, archived())
    .script(PACKAGE_ARCHIVE_COMMAND, archived())
    .script(DISCARD_COMMAND, { exitCode: 0 })
    .script(EXTRACT_COMMAND, { exitCode: 0 })
    .script(PACKAGE_EXTRACT_COMMAND, { exitCode: 0 });
}
