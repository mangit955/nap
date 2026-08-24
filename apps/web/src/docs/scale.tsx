/**
 * What happened when execution left the request, and what the ramp says about it.
 *
 * This section holds the scaling *mechanism* numbers — the lease's renewal interval, the pod
 * counts, the ramp's headline figures — for the same reason `durable-jobs.tsx` holds the repair
 * bound: the README states that Nap scales horizontally and links here, and a figure quoted in two
 * places is a figure that goes stale in one of them.
 *
 * The load write-ups in `docs/` are the exception the other way round: they are a measurement with
 * a date on it, they say what is still marginal, and they are linked rather than summarised past
 * the headline. Anything here that disagrees with them is this file being wrong.
 */

import { REPO_URL } from "../landing/github-button.tsx";
import { Code, Facts, Figure, Lede, P, Source, Sub, Term } from "./prose.tsx";

const PROCESSES = `one image, three commands, no call between them

API      bun apps/api/src/index.ts    serves HTTP + sockets    executes nothing
Worker   bun apps/api/src/worker.ts   executes turns           serves nothing
Reaper   bun apps/api/src/reaper.ts   sweeps, reconciles       exactly one replica

the only thing between them:  turn_requests, and the event log`;

const LEASE = `queued ──claim──► leased ──settle──► succeeded
                   │                     failed
                   │                     cancelled
                   └──lease expires──► the janitor closes it out

  no path back to queued — a redelivered turn is a second model run somebody pays for`;

export function Scale() {
  return (
    <>
      <Lede>
        A turn used to run inside the request that asked for it. That is a shape with a hard ceiling
        and one expensive failure, and getting out of it is most of what the last stretch of work
        was.
      </Lede>

      <P>
        The ceiling first: while the API process was the worker, a request&rsquo;s lifetime was the
        turn&rsquo;s lifetime. A deploy was a lost turn, a crash was a lost turn, and there was
        nothing to scale on its own — sockets and model loops shared one event loop, so the thing
        you would add capacity for and the thing you would add it because of could not be separated.
      </P>

      <P>
        The failure is worse and is the one that actually decided it. Two API replicas accept two
        turns for one session, each calls <Code>acquireSandbox</Code>, and the project ends up
        holding two E2B sandboxes — one of which nothing references and nothing stops paying for.
        Keeping turns apart with a map of promises inside a process is correct in that process and
        enforces nothing across two.
      </P>

      <Figure label="The binary is split by role, not by codebase.">{PROCESSES}</Figure>

      <Sub>The queue is a Postgres table, deliberately</Sub>

      <P>
        <Code>turn_requests</Code>, claimed with <Code>for update skip locked</Code>. Per-session
        exclusivity is a partial unique index — one <Code>leased</Code> row per session, enforced by
        the database rather than by every caller remembering — so <Term>busy</Term> means the same
        thing in every process, and the close, delete and idle-sweep paths all ask one question to
        find out.
      </P>

      <P>
        Redis, JetStream and a hosted queue are all better queues than a table. Every feature they
        bring over one — retry policy, backoff, dead-lettering, a visibility timeout — is aimed at{" "}
        <em>redelivery</em>, and redelivery is the single thing this system must not do: a turn
        delivered twice is a model run somebody pays for twice. Recovery here is the event
        log&rsquo;s job, not the queue&rsquo;s, because a job is a fold over that log and already
        knows how far it got.
      </P>

      <Figure label="A turn request has no path back to queued.">{LEASE}</Figure>

      <P>
        A worker renews its lease while it works and{" "}
        <Term>aborts the turn the moment a renewal says the lease is gone</Term> — a worker that has
        been declared dead must stop being alive. Shutdown is a drain rather than a stop: it quits
        claiming, keeps renewing what it holds, and aborts only what is left at the deadline.
      </P>

      <Sub>Then the events have to cross too</Sub>

      <P>
        Once a turn runs on a worker, every socket watching it is on an API pod, and an in-process
        bus reaches none of them. That failure is silent in the worst way — every turn executes
        perfectly and every chat pane sits still — so the two processes that publish refuse to boot
        without the cross-process bus rather than letting it be discovered from a browser.
      </P>

      <Facts
        items={[
          {
            term: "The notification carries no payload",
            body: (
              <>
                <Code>pg_notify</Code> sends a session and a <Code>seq</Code>; the receiving pod
                reads the events out of the log. Postgres caps a notification at 8,000 bytes, and
                the events that would exceed it are exactly the interesting ones — a build log, a
                written file. A payload-carrying design works in every test and then drops those.
              </>
            ),
          },
          {
            term: "A missed wake-up costs latency, not an event",
            body: "A catch-up poll asks the same question every two seconds regardless, so the notification is an optimisation over a loop that would have got there anyway.",
          },
          {
            term: "One delivery path, not two",
            body: "The live path and the replay path read the same rows. A message and a row would be two copies of one event that can disagree, and only one of them would be the tested one.",
          },
        ]}
      />

      <Sub>What the ramp says</Sub>

      <P>
        The same k6 script was run against one process and then against a Kubernetes cluster — three
        API pods, two-to-four workers, one reaper, KEDA scaling the workers on queue depth and an
        HPA on open sockets. Only the architecture underneath differs; the model and the sandbox are
        the same fakes at the same recorded speeds, which is why the whole thing costs nothing and
        can be run again.
      </P>

      <P>
        At <Term>100 concurrent turns</Term> the cluster ran 2,310 turns with 100% job, turn and
        verification completion — zero sequence gaps, zero duplicates, zero WebSocket failures, zero
        5xx — including 219 mid-turn reconnects that each asked for the gap and got exactly it.
        Admission and delivery both got <em>faster</em> as load rose. The workers scaled on queue
        depth in both directions, and the API pods, sitting well under their socket target, were
        correctly left alone.
      </P>

      <P>
        Two of the fifteen thresholds failed on the first run and both are written up rather than
        smoothed over: one was the fake measuring itself, and the other was real — the runtime
        acquired a sandbox before emitting anything, so a project&rsquo;s first turn showed its
        author nothing for the length of a cold start. That is fixed, and the prompt is now drained
        before the acquisition. The cold start moved rather than vanished, into{" "}
        <Code>queue_wait</Code>, which is honestly green at two-thirds of its threshold and is named
        as the number to watch.
      </P>

      <P>
        <Source href={`${REPO_URL}/blob/main/docs/scaling-design.md`}>
          scaling-design.md — the semantics and the invariants
        </Source>{" "}
        ·{" "}
        <Source href={`${REPO_URL}/blob/main/docs/scaling-baseline.md`}>
          scaling-baseline.md — one process
        </Source>{" "}
        ·{" "}
        <Source href={`${REPO_URL}/blob/main/docs/scaling-cluster.md`}>
          scaling-cluster.md — nine pods, compared stage by stage
        </Source>{" "}
        ·{" "}
        <Source
          href={`${REPO_URL}/blob/main/docs/adr/0009-turns-execute-on-workers-behind-a-postgres-queue.md`}
        >
          ADR-0009
        </Source>{" "}
        ·{" "}
        <Source href={`${REPO_URL}/blob/main/docs/adr/0010-event-fanout-is-notify-then-read.md`}>
          ADR-0010
        </Source>
      </P>
    </>
  );
}
