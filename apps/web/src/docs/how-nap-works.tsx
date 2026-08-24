/**
 * The orientation section: what happens between typing a sentence and coming back to an app.
 *
 * It is deliberately the only section that describes the whole path end to end. Everything after
 * it takes one stretch of that path and explains why it is built the way it is, so this is the
 * map they hang off — and the reason a reader who stops after this section has still been told
 * something true.
 */

import { Code, Facts, Figure, Lede, P, Recording, Term } from "./prose.tsx";

const FLOW = `you                 "a todo list with add, complete and delete"
  │
API                 admits it, writes it to the queue, answers — and runs none of it
  │
Worker              claims the request and holds a lease on your session
  │
Runtime             opens a job, says something, acquires a sandbox
  │
ContextEngine       assembles the prompt within a token budget
  │
AgentService        drives the model loop, one tool call at a time
  │                   read_file · write_file · edit_file
  │                   list_files · search_files · run_command
  │
sandbox             files land, the dev server reloads, the preview updates
  │
Runtime             persists → publishes → commits → verifies → snapshots
  │
you                 come back to it running`;

export function HowNapWorks() {
  return (
    <>
      <Lede>
        You describe an app in a sentence. An agent builds it on a machine of its own. The point of
        everything below is that you do not have to watch it happen.
      </Lede>

      {/*
        The recording belongs at the very top of this section: it is the one piece of evidence on
        the page that is not an argument, and a reader who watches it has already been told what
        the sections below go on to explain.

        The README carries a 22s cut of this same run. Both are built by scripts/demo-cuts.sh from
        one master, so the short one is always a subset of what is playing here.
      */}
      <Recording
        src="/demo.mp4"
        poster="/demo-poster.jpg"
        label="A recorded Nap session, from an empty dashboard to a finished app"
        caption="One session, uncut: a sentence, a sandbox waking up, the agent reading and writing files, the project's own checks run against what it claimed, and the app it left behind."
      />

      <P>
        A <Term>turn</Term> is one exchange: your prompt, whatever the agent does about it, and
        exactly one terminal event saying it finished or failed. A <Term>job</Term> is the objective
        behind it, and it outlives the turn — a trivial request is a job that opens and closes in a
        single turn, and a large one is a job that spans six, without anything having had to decide
        in advance which it was going to be.
      </P>

      <Figure label="One turn, from a sentence to a running preview.">{FLOW}</Figure>

      <P>
        The last line of that diagram is where most of the engineering is. A turn that changed files
        is committed and then <Term>verified</Term> against the project&rsquo;s own checks, because
        a model saying it is finished is a claim rather than a finding. A project nobody has touched
        for a while is committed, bundled and destroyed, because a sandbox is billed by the second.
        And every step of it is written to a durable, ordered event log, because the story of what
        happened has to survive you closing the tab.
      </P>

      <Facts
        items={[
          {
            term: "Leaving costs nothing",
            body: (
              <>
                An idle project is snapshotted to object storage and its sandbox destroyed. Your
                next message restores it — files and git history intact.
              </>
            ),
          },
          {
            term: "The work is not in your request",
            body: (
              <>
                A worker claims the turn and runs it; the socket you were watching from is not the
                process doing anything. Closing the tab stops the watching and nothing else.
              </>
            ),
          },
          {
            term: "Coming back has a place to start",
            body: (
              <>
                The transcript opens at the <Term>seam</Term> your reading stopped at, and one card
                above it says what was <em>decided</em> in your absence — if anything was.
              </>
            ),
          },
          {
            term: "Rejoining is one question",
            body: (
              <>
                The transcript is a fold over an append-only log, so catching up is{" "}
                <Code>everything after seq</Code>. A reconnect an hour later is the same operation
                as a reconnect a second later.
              </>
            ),
          },
          {
            term: "Finishing is not the model's call",
            body: (
              <>
                A completed turn is committed, then checked. Passing makes that commit a{" "}
                <Term>checkpoint</Term>; failing opens a repair turn carrying the failure.
              </>
            ),
          },
        ]}
      />
    </>
  );
}
