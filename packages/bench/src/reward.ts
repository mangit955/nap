/**
 * A report projected into the numbers an external evaluation harness understands — and the
 * cases where it must refuse to produce any.
 *
 * This is the pure half of the verifier that will eventually run under Harbor. It lives here
 * rather than in the shell for the reason `docs/adr/0001` gives: deciding *what* a run is worth
 * is evaluation logic, and writing a file is plumbing. The consequence is that the rule below
 * is unit-tested for free, and the harness adapter, when it arrives, is a function that writes
 * whatever this returns.
 *
 * **The rule the whole migration turns on: an unmeasured run yields no reward.** Harbor rewards
 * are numeric — a float or an integer, with no null and no "unmeasurable" state — so an errored
 * run has only two honest destinations, zero or nothing, and zero is a lie. `docs/NAPBENCH.md`
 * is blunt about why: a benchmark that quietly attributes infrastructure noise to a model is
 * worse than no benchmark. An E2B outage, a browser that would not start, a missing credential
 * and a run somebody cancelled are all *absences of evidence about the model*, and reporting
 * them as the worst possible score converts our bad afternoon into the model's bad result.
 *
 * So this returns nothing for those, and the caller writes no reward file and exits non-zero —
 * a failed *trial* rather than a scored one. Nothing is lost by it: the full report, with the
 * status, the error kind, every check and the trajectory, is written to the job directory
 * either way. The reward is a lossy projection of a lossless artefact, and it is allowed to be
 * lossy precisely because the artefact is not.
 */

import type { BenchReport } from "./report.ts";
import { carriesScore } from "./status.ts";

/**
 * Named metrics on a 0–1 scale, which is the shape Harbor's `reward.json` accepts.
 *
 * Several rather than one, because a single float would throw away the decomposition that is
 * the point of the report — `overall` alone cannot tell a reviewer that the application worked
 * and looked bad. Kept as a plain record so this package need not know what the consumer calls
 * these; the adapter serialises it verbatim.
 */
export type Reward = Record<string, number>;

/**
 * The reward for a run, or nothing when the run measured nothing.
 *
 * `undefined` rather than a zero-valued reward, and there is deliberately no code path that
 * returns zero for an unmeasured run. See this file's header.
 */
export function rewardFor(report: BenchReport): Reward | undefined {
  // Asked of the status rather than of the score, so cancellation and error travel the same
  // route as they do everywhere else in this package, and a future status is caught by the one
  // predicate that already decides which statuses carry a result.
  if (!carriesScore(report.status)) return undefined;
  if (report.score === null) return undefined;

  const reward: Reward = { overall: report.score / 100 };

  // The halves, when the run was scored with them. Named so that a consumer plotting reward
  // over time can see which half moved — the case this benchmark now exists to distinguish.
  if (report.halves !== null) {
    reward.objective = report.halves.objective / 100;
    if (report.halves.product !== null) reward.product = report.halves.product / 100;
  }

  for (const category of report.categories) {
    reward[category.category] = category.score / 100;
  }

  return reward;
}
