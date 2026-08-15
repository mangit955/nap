/**
 * One sentence explaining why something did not parse, in the form every parser here returns.
 *
 * Extracted because five modules had written it out identically — `task`, `report`, `trajectory`,
 * `screenshot`, `visual` — and the shape of a parse failure is part of NapBench's interface: it is
 * what a CLI prints when a hand-written task file has a typo in it. Five copies is five chances
 * for one of them to start phrasing it differently, and the reader who notices is the one holding
 * two error messages about the same kind of mistake.
 *
 * The label is what a top-level failure is called when the issue has no path — zod reports those
 * with an empty path, and "": expected object would tell nobody anything.
 */

import type { z } from "zod";

export function describeParseFailure(error: z.ZodError, label: string): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || label}: ${issue.message}`)
    .join("; ");
}
