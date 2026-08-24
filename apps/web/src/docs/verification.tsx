/**
 * What the system finds, as against what the model claims.
 *
 * The three-valued check and the three-valued verdict are the substance of this section, and both
 * are here because the middle value in each is the one that took work: *absent* is not failure,
 * and *errored* is not the project's fault.
 */

import { REPO_URL } from "../landing/github-button.tsx";
import { Code, Facts, Figure, Lede, P, Source, Sub, Term } from "./prose.tsx";

const LOOP = `turn.completed          the model's claim
      │
      ├── changed no files ──────────────► job closes: unverified
      │
      ▼
commit                  every completed turn commits
      │
      ▼
run the project's checks, cheapest first, stopping at the first failure
      │
      ├── passed  ──► the commit becomes a checkpoint, job closes: verified
      ├── failed  ──► a repair turn opens, carrying the failure
      └── errored ──► nothing was learned; job closes: abandoned`;

export function Verification() {
  return (
    <>
      <Lede>
        <Code>turn.completed</Code> is the model&rsquo;s claim that the work is done, not the
        system&rsquo;s finding that it is. Verification is what turns one into the other.
      </Lede>

      <Figure label="What happens after the model says it has finished.">{LOOP}</Figure>

      <Sub>A check has three outcomes, and the third is load-bearing</Sub>

      <P>
        A <Term>check</Term> is one command, run in the sandbox, that passed, failed, or was{" "}
        <Term>absent</Term>. Absent is not failure, and the gap matters in both directions: a
        project with no test script has not failed its tests, and treating a missing script as a
        failure would put every fresh project into a repair loop it cannot leave.
      </P>

      <P>
        Which checks exist is <em>discovered from the project</em> rather than declared by the model
        — read out of its manifest, so an agent cannot pass by claiming a check it never had. They
        run cheapest first and stop at the first failure, because the second failure teaches nothing
        the first has not already earned a repair turn for.
      </P>

      <Sub>A verdict has three outcomes too, and they are not the same three</Sub>

      <Facts
        items={[
          {
            term: "Passed",
            body: "The run is sound. The commit becomes a checkpoint.",
          },
          {
            term: "Failed",
            body: "The project's own problem, and the thing a repair turn is for.",
          },
          {
            term: "Errored",
            body: (
              <>
                Nothing was learned about the project — the sandbox refused the command, or the
                preview listens inside and is unreachable from outside. A repair turn on that would
                ask a model to fix a machine it cannot see, so{" "}
                <Term>an errored run is never written as a verification</Term> and the job ends
                abandoned instead.
              </>
            ),
          },
        ]}
      />

      <Sub>Repair is a turn, not a smaller thing</Sub>

      <P>
        A failed verification opens a repair turn, and it is an ordinary turn whose prompt happens
        to come from the failure rather than from you. That is what makes it inherit budgets,
        cancellation, event ordering and commit-on-completion without any of them being rebuilt. The
        bound is attempts rather than a token ledger: three, after which the job closes{" "}
        <Term>exhausted</Term> with the last good checkpoint still intact.
      </P>

      <P>
        Each repair carries a <Term>job brief</Term> — the objective, and every verification failure
        already seen on this job, oldest first. That second half is procedural memory done
        deterministically, and it exists because a transcript shows the model confidently finishing
        and never that the finish was rejected. Without it, each repair is free to make the last
        one&rsquo;s mistake again. It is near-unevictable from the context window on purpose: the
        situation it exists for is a long repair with a full window, which is exactly when the turn
        that stated the objective has fallen out of it.
      </P>

      <Sub>What a long job costs, and the ceiling that actually fires</Sub>

      <P>
        Four turns on one project is where that stops being theoretical. Two ceilings exist and they
        are not the same ceiling: one caps a <em>single request</em>, the other caps the{" "}
        <em>sum over a turn&rsquo;s round trips</em> — and a turn re-sends its whole transcript on
        every round trip, so its bill is roughly the assembled size <em>times</em> its step count.
        Both factors grow with the session. A real funded session died on the second ceiling while
        sitting at a fifth of the first, which means the truncation ladder was perfectly correct and
        had never run.
      </P>

      <P>
        So tool traffic from any turn older than the most recent one is emptied{" "}
        <Term>unconditionally</Term>, before the budget is consulted. The call keeps its shape —
        which tool, against which path — so the turn still reads as something that happened; what
        goes is any argument big enough to be a file&rsquo;s contents, and everything the call
        printed. Prose on both sides is never touched. That is a different question from truncation,
        which is still the only answer to <em>this does not fit</em>: fitting was never the test,
        being worth ten to forty copies is.
      </P>

      <P>
        The failing session&rsquo;s event log is committed to the repository unedited, so the
        measurement behind that reproduces for nothing rather than being a number in a paragraph.
      </P>

      <P>
        The whole loop is confined to sandbox commands and a preview probe. Driving a browser stays
        the benchmark&rsquo;s alone — nothing that ships carries Playwright.
      </P>

      <P>
        <Source
          href={`${REPO_URL}/blob/main/docs/adr/0006-a-completed-turn-is-a-claim-not-a-fact.md`}
        >
          ADR-0006
        </Source>
        {" · "}
        <Source
          href={`${REPO_URL}/blob/main/docs/adr/0007-the-check-primitive-moves-below-both.md`}
        >
          ADR-0007 — The check primitive moves below both the runtime and the benchmark
        </Source>
        {" · "}
        <Source
          href={`${REPO_URL}/blob/main/docs/adr/0011-an-old-turns-tool-traffic-is-not-worth-carrying.md`}
        >
          ADR-0011 — An old turn&rsquo;s tool traffic is not worth carrying
        </Source>
      </P>
    </>
  );
}
