/**
 * How the agent is measured, and what the benchmark refuses to claim.
 *
 * The weights and the error-kind split are the two things a sceptical reader will want, in that
 * order: the first says what a score is made of, the second says when there is no score and why
 * that is not the same as a zero.
 */

import { REPO_URL } from "../landing/github-button.tsx";
import { Code, Facts, Figure, Lede, P, Source, Sub, Term } from "./prose.tsx";

const WEIGHTS = `functional   50    does it do what was asked
browser      25    does it behave when driven
visual       15    how it looks — no judge exists yet, so it renormalises out
code         10    lint, typecheck, accessibility audit

a category that produced no results is not scored zero.
the remaining weights renormalise over what was actually measured.`;

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

      <Figure label="The default category weights.">{WEIGHTS}</Figure>

      <P>
        Functional dominates deliberately: an application that does not do what was asked is a
        failure however well it is written or laid out. The renormalisation is the part that keeps
        it honest — a run nobody judged visually is scored over what <em>was</em> measured, rather
        than docked fifteen points for a judge that does not exist.
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
            body: "Baseline and candidate, and what moved per category and per check. Refused outright when the two effective weight vectors differ, because a renormalised score is only meaningful relative to the categories that produced it.",
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
