/**
 * How the agent is measured, and what the benchmark refuses to claim.
 *
 * The arithmetic and the error-kind split are the two things a sceptical reader will want, in that
 * order: the first says what a score is made of, the second says when there is no score and why
 * that is not the same as a zero.
 *
 * This is where the *mechanism numbers* live — the weights, the anchors, the geometric
 * combination. The README states consequences and links here; see the root CLAUDE.md. Funded
 * runs' headline figures are the one exception and belong to neither of us.
 */

import { REPO_URL } from "../landing/github-button.tsx";
import { Code, Facts, Figure, Lede, P, Source, Sub, Term } from "./prose.tsx";

const HALVES = `overall = √(objective × product)

  correct 95, beautiful 90  →  92
  correct 95, ugly      25  →  49
  broken  30, beautiful 90  →  52, then capped at 40 by the build gate
  broken  30, ugly      25  →  27

neither half can carry the other. under a weighted mean,
the second line lands in the eighties.`;

const WEIGHTS = `functional   50    does it do what was asked
browser      25    does it behave when driven
visual       15    v1, superseded — appearance is now the product half
code         10    typecheck and the accessibility audit

a category that produced no results is not scored zero.
the remaining weights renormalise over what was actually measured.`;

const SCALE = `excellent 95   good 78   moderate 55   weak 35   poor 12

nine dimensions, equally weighted: hierarchy, typography, spacing,
color, layout, components, interaction, responsiveness, restraint.
a tenth, polish, is reported and never scored.

not_assessable carries no number at all. it renormalises.`;

export function NapBench() {
  return (
    <>
      <Lede>
        NapBench is the harness that measures Nap&rsquo;s agent: a <Term>task</Term> is a
        reproducible unit of work put to it, a <Term>run</Term> is one execution of one task against
        one configuration, and a run ends as a report with a score and a trajectory.
      </Lede>

      <P>
        Tasks are data, validated by a schema as they load, and independent of how Nap is built — so
        the same task can be pointed at a different model, prompt or context engine without being
        edited. A custom check kind was specified and deliberately not built: a check that was code
        is one no schema can validate and no sandbox can be handed.
      </P>

      <Sub>What a score is made of</Sub>

      <P>
        A score has two halves. The <Term>objective half</Term> asks whether the application does
        what was asked, and is a weighted mean over checks that a machine ran. The{" "}
        <Term>product half</Term> asks whether anybody would want to use what was built, and is a
        judge&rsquo;s grades over screenshots. They are combined <em>geometrically</em>.
      </P>

      <Figure label="Why the two halves multiply rather than average.">{HALVES}</Figure>

      <P>
        Under a weighted mean, correctness buys the rest: an application that does exactly what was
        asked and looks terrible still lands in the eighties, which is not a result anybody shipping
        to a real user would call good. Multiplied, a weak half drags a strong one down towards it
        instead of being averaged away. The opposite direction was already covered — a preview that
        never serves fails the run outright, and a failed build caps it.
      </P>

      <Figure label="The objective half: the default category weights.">{WEIGHTS}</Figure>

      <P>
        Functional dominates deliberately: an application that does not do what was asked is a
        failure however well it is written or laid out. The renormalisation is the part that keeps
        it honest — a category that produced no results is scored over what <em>was</em> measured
        rather than docked its weight for something nobody ran. An unjudged run is treated the same
        way and is scored on its objective half alone, never on a product half of zero.
      </P>

      <Sub>How the product half is graded</Sub>

      <Figure label="The ordinal scale, and the dimensions it is applied to.">{SCALE}</Figure>

      <P>
        The judge is shown{" "}
        <em>screenshots and one neutral sentence about what the application is for</em>, and nothing
        else — no source, no prompts. Screenshots-only is what stops it rewarding a stack it
        recognises rather than a product that is good; withholding the prompts is what stops it
        grading feature completion, which the checks already measure and measure better, because a
        check cannot be talked round.
      </P>

      <P>
        And it is never asked for a number. A judge asked for <Code>73</Code> invents precision it
        does not have, and the same screenshots come back 68 the next run; asked whether typography
        is <Code>weak</Code> or <Code>moderate</Code>, it is making a judgement a reader can check
        against the evidence it cited. Every graded dimension has to carry that evidence, naming the
        screenshot it came from — enforced by the schema, because a prompt is a request and a schema
        is a refusal.
      </P>

      <P>
        One judge carries one judge&rsquo;s taste, and that is a disclosed limitation rather than a
        solved problem. What is done about it: the grades are ordinal so the bias is at least
        stable, every judgement records which judge and which rubric version produced it, and nine
        hand-written fixtures — the same application designed nine ways — exist to check that the
        judge can tell them apart at all. An evaluator nobody has watched discriminate is a check
        that has never been observed failing.
      </P>

      <P>
        Sitting above all of it are <Term>gates</Term>: an ordered list of pure functions that
        constrain the outcome regardless of what the checks summed to. A preview that never serves
        fails the run. A failed required check fails the run. A build failure fails it and caps the
        score. Gates exist so a broken application cannot score well by being good at everything
        except working.
      </P>

      <Sub>When there is no score</Sub>

      <P>
        A run ends <Term>passed</Term>, <Term>failed</Term>, <Term>errored</Term> or{" "}
        <Term>cancelled</Term>. The first two are results and both have a score. Errored means no
        result was obtained, so there is no number to give — and an errored run is attributed to one
        of seven kinds, in four groups: the system under test, what it depends on, the instrument,
        and the operator.
      </P>

      <P>
        That split is what keeps the benchmark honest. An agent that refused and a provider outage
        both produce no score, and only the first is evidence about the agent. What is measured is
        the model, with Nap held fixed, so the question is not whose code was at fault but whether
        the failure says anything about a model.
      </P>

      <Facts
        items={[
          {
            term: "A run repeated has a spread; a run once does not",
            body: "Mean, median, sample standard deviation and range — reported per task, never across a suite. A deviation over different tasks measures how much the tasks differ in difficulty, which is a fact about the benchmark rather than about the model.",
          },
          {
            term: "A comparison is two runs, never three",
            body: "Baseline and candidate, and what moved per category and per check. Refused outright when the two effective weight vectors differ, because a renormalised score is only meaningful relative to the categories that produced it — and refused across the two arithmetics, because both land on 0–100 and that is exactly what makes them dangerous side by side.",
          },
          {
            term: "An unmeasured run yields no reward at all",
            body: "Projected into an external harness, a report becomes named metrics on a 0–1 scale. An errored or cancelled run gets none of them: the format has no null, so the only alternatives are zero or nothing, and zero would convert our bad afternoon into the model's bad result. The full report is written either way — the reward is a lossy projection of a lossless artefact.",
          },
          {
            term: "Route is not duration",
            body: "Tool calls, tool failures, commands run and files touched — the claim 'same score, different route' is about two runs doing different things, so time and token counts are reported beside it and excluded from deciding it.",
          },
        ]}
      />

      <P>
        <Source href={`${REPO_URL}/blob/main/docs/NAPBENCH.md`}>docs/NAPBENCH.md</Source>
        {" · "}
        <Source href={`${REPO_URL}/blob/main/docs/adr/0004-napbench-measures-the-model.md`}>
          ADR-0004 — NapBench measures the model
        </Source>
        {" · "}
        <Source
          href={`${REPO_URL}/blob/main/docs/adr/0012-the-score-becomes-two-halves-combined-geometrically.md`}
        >
          ADR-0012 — two halves, combined geometrically
        </Source>
        {" · "}
        <Source
          href={`${REPO_URL}/blob/main/docs/adr/0013-product-quality-is-graded-ordinally-from-screenshots.md`}
        >
          ADR-0013 — graded ordinally, from screenshots
        </Source>
      </P>

      <P>
        Scores from a run against fakes mean nothing and are not published as though they did; a
        funded run against real infrastructure gets a write-up of its own, in{" "}
        <Source href={`${REPO_URL}/tree/main/docs`}>
          <Code>docs/napbench-*.md</Code>
        </Source>
        .
      </P>
    </>
  );
}
