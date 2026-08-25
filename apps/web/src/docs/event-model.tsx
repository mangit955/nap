/**
 * Durable append then fanout, and everything that falls out of fixing that order.
 *
 * This is the section that has to land, because the product's whole claim — leave, come back,
 * nothing was lost — is a consequence of one ordering decision rather than of anything the model
 * does. The transcript half is here rather than in a section of its own: a derived view is only
 * interesting next to the log it is derived from.
 */

import { REPO_URL } from "../landing/github-button.tsx";
import { Code, Facts, Figure, Lede, P, Source, Sub, Term } from "./prose.tsx";

const ORDER = `append to Postgres  (seq assigned, monotonic per session)
        │
        ▼
publish to the bus  (whoever is listening, if anybody is)

never the other way round.`;

export function EventModel() {
  return (
    <>
      <Lede>
        Every durable fact about a session is an <Term>event</Term> with a sequence number, written
        to Postgres <em>before</em> it is published to anybody watching.
      </Lede>

      <P>
        Publishing first is faster, and it means a client can see an event that a crash then loses —
        after which the browser and the database disagree and nothing can say which of them is
        right. Fixing the order costs a write on the hot path and buys the property the rest of the
        system is built on: the log is authoritative, and what a client holds is a copy of it.
      </P>

      <Figure label="The order that makes catching up decidable.">{ORDER}</Figure>

      <P>
        Because the order is fixed, catching up is a single question —{" "}
        <Code>everything after seq</Code>. A reconnect a second later and a reconnect an hour later
        are the same operation, so there is no separate resume path to get wrong, and joining
        mid-turn needs no special case.
      </P>

      <Sub>The session log, and the views over it</Sub>

      <P>
        A <Term>session log</Term> is one reader&rsquo;s copy of the events: one socket, one{" "}
        <Code>seq</Code>, many derived views. There is exactly one per workspace — a second is two
        clients that can disagree about what the newest event was.
      </P>

      <P>
        The <Term>transcript</Term> is the conversation you actually see, and it is a fold over that
        log rather than state of its own. It is much shorter than the log it comes from, because one
        tool call, everything it printed, the files it touched and how it ended are four kinds of
        event and a single thing on screen. Nothing is ever written into it: it is recomputed from
        the log every frame, which is why joining mid-turn, reloading the page and watching from a
        second tab all land on the same picture without anything having to be reconciled.
      </P>

      <Facts
        items={[
          {
            term: "Three speakers, not two",
            body: (
              <>
                The user, the agent, and the <Term>verifier</Term> — which is a fact about the log
                rather than a third party to the conversation.
              </>
            ),
          },
          {
            term: "A second view is another fold",
            body: "Not another copy. Anything that wanted a different reading of the same session derives it from the log rather than keeping its own.",
          },
          {
            term: "The notification is not the event",
            body: (
              <>
                Across several server processes, publishing is a Postgres <Code>NOTIFY</Code>{" "}
                carrying a session and a <Code>seq</Code> and nothing else; each process then reads
                the events themselves out of the log. So a wake-up that never arrives costs latency
                rather than an event — a poll asks the same question every two seconds anyway — and
                the socket you are on need not be the process running your turn.
              </>
            ),
          },
        ]}
      />

      <Sub>Two cursors, and why they must not share a word</Sub>

      <P>
        The <Code>seq</Code> above is a <em>replay</em> cursor: per-connection, held in memory, and
        gone when the page closes. It answers &ldquo;what have I been sent?&rdquo; The second cursor
        answers a different question — &ldquo;what has this browser ever <em>displayed</em>?&rdquo;
        — and it is per-browser and durable, kept in <Code>localStorage</Code> against the session.
        The events after it are <Term>unseen</Term>, and where they begin is the <Term>seam</Term>:
        a line through the transcript, and where the transcript opens rather than at the bottom.
      </P>

      <P>
        The seen cursor advances <em>only while the document is visible</em>. A background tab keeps
        its socket open and the worker keeps working, so counting what arrives there as displayed
        would make the feature fire in every case except the one it exists for. And having received
        nothing is not a cursor of zero: writing that first zero down turns &ldquo;never
        opened&rdquo; into &ldquo;seen nothing of it&rdquo; and puts the seam above the first thing
        anybody said.
      </P>

      <P>
        <Term>Unseen</Term> is deliberately not <em>away</em>. Away names the user&rsquo;s state,
        which nothing can observe; what is computed is a property of the log against a cursor. The
        copy on screen may well say &ldquo;while you were away&rdquo; — copy is allowed to be warmer
        than the concept, so long as the concept keeps its name in the source.
      </P>

      <P>
        What sits above the seam is one card, and it fires on a <em>conclusion</em> — a job
        completed, checkpointed or failed among the unseen events — rather than on elapsed time or
        volume. Both of those fire on activity: gone four hours with nothing decided, and you would
        be told &ldquo;47 events&rdquo;, which is true and worthless. Most returns show no card, and
        that is what earns the one that appears its interruption. It is worked out once, when
        reading resumes, and then held still, because a card recomputed every frame would announce
        &ldquo;while you were away&rdquo; about the turn its reader is sitting there watching.
      </P>

      <P>
        <Source href={`${REPO_URL}/blob/main/docs/adr/0008-the-transcript-is-a-derived-view.md`}>
          ADR-0008 — The transcript is a derived view, not a chat client
        </Source>
      </P>
    </>
  );
}
