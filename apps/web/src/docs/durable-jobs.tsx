/**
 * The job: one objective, folded out of the log, surviving the turn it started in.
 *
 * The number that matters here is the repair bound, and it is stated once, in this section, as
 * `MAX_REPAIR_ATTEMPTS` reads it. The README says a job is bounded; how many attempts that comes
 * to is a mechanism, and mechanisms live here.
 */

import { REPO_URL } from "../landing/github-button.tsx";
import { Code, Facts, Figure, Lede, P, Source, Sub, Term } from "./prose.tsx";

const PHASES = `open        working ──► verifying ──► repairing ──┐
                  ▲                            │
                  └────────────────────────────┘   up to 3 attempts

closed      verified     checks passed — the commit is a checkpoint
            unverified   the turn changed no files, so there was nothing to check
            exhausted    3 repairs spent, checks still red
            abandoned    the turn it was riding on was cancelled or refused`;

export function DurableJobs() {
  return (
    <>
      <Lede>
        A <Term>job</Term> is one objective and the durable unit of work that outlives a turn: what
        was asked, what phase it is in, what has been verified, and how many repair attempts remain.
      </Lede>

      <P>
        It has no table and no file behind it. A job is a fold over the session&rsquo;s events,
        exactly as a turn is — so there is one source of truth rather than two that can disagree,
        and resuming is replaying. Every turn belongs to one. A job opens on a prompt and stays open
        until verification agrees it is satisfied or its attempts run out, which is why a trivial
        request and a six-turn build need no decision in advance about which they are.
      </P>

      <Figure label="Three phases while open, four ways to close.">{PHASES}</Figure>

      <P>
        <Term>Unverified</Term> is the one worth pausing on: a turn that changed no files has not
        failed its checks, because there was nothing to check. Calling that a failure would put
        every conversational turn into a repair loop it cannot leave. It is not a success either,
        and it gets its own word rather than being folded into one of the neighbours.
      </P>

      <Sub>Continuing, which is not resuming</Sub>

      <P>
        A process restart leaves a job <em>open</em> rather than failing it. When the project is
        next opened, the open job is continued — and nothing continues a job while nobody is
        watching, which is deliberate: an unattended sandbox is a sandbox being paid for.
      </P>

      <P>
        That is a different word from <Term>resume</Term>, which already means bringing a put-away
        project&rsquo;s sandbox back up. The two are separate operations on separate things, and the
        glossary keeps them apart on purpose.
      </P>

      <Sub>What you actually see of it</Sub>

      <P>
        A strip above the transcript says where the current job stands, and it does not scroll away
        with the conversation — a status somebody goes looking for during the exact minute it
        matters should not be a thing they have to scroll to find. It is mirrored into the workspace
        bar, so collapsing the chat to give the preview the whole window does not take the one
        signal saying whether the project works off the screen with it.
      </P>

      <P>
        Behind it is a history of <em>jobs</em>, and that word is the decision worth reading.{" "}
        <Code>job.checkpointed</Code> is written on the success path only, so a history built from
        checkpoints is a history with every failure deleted from it: green ticks, and no record that
        the thing asked for at 14:32 was attempted, repaired three times and abandoned. A panel
        whose job is to answer &ldquo;what happened?&rdquo; cannot be built that way. So{" "}
        <Term>Checkpoint</Term> keeps its strong meaning on the verified-commit line <em>inside</em>{" "}
        an entry, and the entries themselves include the ones that ended badly.
      </P>

      <Facts
        items={[
          {
            term: "One function decides all of it",
            body: (
              <>
                <Code>foldJobs</Code> in <Code>@nap/shared</Code> — pure, over the event list, with
                no I/O and nothing to mock.
              </>
            ),
          },
          {
            term: "A job is not a benchmark task",
            body: "NapBench's task is a specification of work to be repeated; a job is one actual piece of work being done once. The words collide and both keep their names.",
          },
        ]}
      />

      <P>
        <Source
          href={`${REPO_URL}/blob/main/docs/adr/0006-a-completed-turn-is-a-claim-not-a-fact.md`}
        >
          ADR-0006 — A completed turn is a claim, not a fact
        </Source>
      </P>
    </>
  );
}
