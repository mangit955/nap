/**
 * What running one check produced.
 *
 * Three values, not a boolean, and the third is the one that matters. *Absent* means nobody
 * asked — there is no `lint` script, or an earlier failure stopped the run before this one —
 * while *failed* means it was asked and did not get what it wanted.
 *
 * The gap is load-bearing: a fresh project with no test script has not failed its tests, and
 * treating a missing script as a failure would open a repair loop that no amount of repairing can
 * close.
 *
 * It sits in `shared` rather than in `@nap/verify` for a mechanical reason:
 * `verification.completed` carries these outcomes, the event contract is defined exactly once
 * in `events.ts`, and nothing below `shared` may be imported from it. Running a check is still
 * `@nap/verify`'s; only the word for what running one produced is everybody's.
 */

import { z } from "zod";

export const CheckOutcomeSchema = z.enum(["passed", "failed", "absent"]);
export type CheckOutcome = z.infer<typeof CheckOutcomeSchema>;
