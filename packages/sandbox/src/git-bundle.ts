import type { SandboxError } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { z } from "zod";

const PREFIX = "# nap snapshot v1\n";
const Head = z
  .string()
  .regex(/^(?:refs\/heads\/\S+|[a-f0-9]{40}|[a-f0-9]{64})$/)
  .refine((head) =>
    [...head].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ),
  );
const Metadata = z.object({ head: Head });

/** Git bundles carry HEAD's value, but not which of several matching branches was checked out. */
export function encodeRepositoryBundle(bundle: Uint8Array, head: string): Uint8Array {
  return Buffer.concat([Buffer.from(`${PREFIX}${JSON.stringify({ head })}\n`), bundle]);
}

export function decodeRepositoryBundle(
  bytes: Uint8Array,
): Result<{ bundle: Uint8Array; head: string | null }, SandboxError> {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, PREFIX.length).toString() !== PREFIX) {
    return { ok: true, value: { bundle: bytes, head: null } };
  }
  const end = buffer.indexOf(10, PREFIX.length);
  if (end < 0 || end - PREFIX.length > 4096) return malformed();
  try {
    const metadata = Metadata.safeParse(JSON.parse(buffer.subarray(PREFIX.length, end).toString()));
    if (!metadata.success) return malformed();
    return { ok: true, value: { bundle: buffer.subarray(end + 1), head: metadata.data.head } };
  } catch {
    return malformed();
  }
}

function malformed(): Result<never, SandboxError> {
  return {
    ok: false,
    error: { code: "exec_failed", message: "The snapshot's Git HEAD metadata is invalid." },
  };
}
