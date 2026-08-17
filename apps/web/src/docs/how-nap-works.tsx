/**
 * The orientation section: what happens between typing a sentence and coming back to an app.
 *
 * It is deliberately the only section that describes the whole path end to end. Everything after
 * it takes one stretch of that path and explains why it is built the way it is, so this is the
 * map they hang off — and the reason a reader who stops after this section has still been told
 * something true.
 */

import { Code, Facts, Figure, Lede, P, Term } from "./prose.tsx";

const FLOW = `you                 "a todo list with add, complete and delete"
  │
Runtime             opens a job, acquires a sandbox
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
        The demo belongs at the very top of this section: it is the one piece of evidence on the
        page that is not an argument. Left as a marked hole rather than a placeholder image —
        a broken frame reads as a bug, an absence reads as work not yet done.

        DEMO GOES HERE. The same ~20s recording the README asks for: type "a todo list with add,
        complete and delete" into the composer, let the tool calls stream in the transcript, stop
        once the preview goes live. Save as apps/web/public/demo.gif, then replace this comment
        with a figure holding it and drop this note.
      */}

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
