/**
 * The eight ADRs, as a list of links rather than as re-rendered prose.
 *
 * They are written for somebody with the code open beside them — context, options weighed,
 * consequences accepted — and reproducing that here would make this page the place they get read
 * and the repository the place they get edited, which is how the two versions start disagreeing.
 * So each one gets the sentence that says whether it is worth opening, and the link.
 */

import { REPO_URL } from "../landing/github-button.tsx";
import { Lede, P, Source } from "./prose.tsx";

const ADR_DIR = `${REPO_URL}/blob/main/docs/adr`;

const DECISIONS = [
  {
    file: "0001-napbench-splits-into-a-pure-package-and-an-app.md",
    title: "NapBench splits into a pure package and an app",
    body: "Tasks, scoring and reports are written against ports; Playwright belongs to the shell alone and to nothing that ships.",
  },
  {
    file: "0002-absent-scoring-categories-renormalise.md",
    title: "Absent scoring categories renormalise rather than score zero",
    body: "An unmeasured category is not a failed one. Scoring it zero would punish a run for a judge that does not exist yet.",
  },
  {
    file: "0003-unmeasurable-metrics-stay-absent.md",
    title: "Metrics the event log cannot supply stay absent",
    body: "Anything the event stream cannot answer is reported as missing rather than inferred, because an inferred metric is indistinguishable from a measured one once it is in a table.",
  },
  {
    file: "0004-napbench-measures-the-model.md",
    title: "NapBench measures the model, and Nap's own faults are infrastructure",
    body: "Fixes the frame of the whole benchmark: an agent that refused is evidence, and a sandbox that died is not.",
  },
  {
    file: "0005-a-navigation-that-never-arrives-is-not-a-broken-application.md",
    title: "A navigation that never arrives is not a broken application",
    body: "The preview gate has already proven the URL serves, so a check that never got there observed nothing and must not record a failure against the agent.",
  },
  {
    file: "0006-a-completed-turn-is-a-claim-not-a-fact.md",
    title: "A completed turn is a claim, not a fact",
    body: "The decision the whole verification and repair loop is built on, and the reason a job exists at all.",
  },
  {
    file: "0007-the-check-primitive-moves-below-both.md",
    title: "The check primitive moves below both the runtime and the benchmark",
    body: "Running one check and saying whether it passed is shared; the edge that must never exist is the system under test importing the thing that grades it.",
  },
  {
    file: "0008-the-transcript-is-a-derived-view.md",
    title: "The transcript is a derived view, not a chat client",
    body: "Nothing is written into what you read; it is recomputed from the log, which is why three tabs cannot disagree.",
  },
] as const;

export function Decisions() {
  return (
    <>
      <Lede>
        Eight decisions that would be expensive to reverse, each recorded where it was made rather
        than reconstructed afterwards.
      </Lede>

      <ol className="mt-7 max-w-2xl space-y-6">
        {DECISIONS.map((decision, index) => (
          <li key={decision.file} className="flex gap-4">
            <span className="pt-0.5 font-mono text-[11px] text-[var(--s-text-subtle)] tabular-nums">
              {String(index + 1).padStart(4, "0")}
            </span>
            <div>
              <p className="text-[15px] leading-snug">
                <Source href={`${ADR_DIR}/${decision.file}`}>{decision.title}</Source>
              </p>
              <p className="mt-1.5 text-[14px] text-[var(--s-text-muted)] leading-[1.7]">
                {decision.body}
              </p>
            </div>
          </li>
        ))}
      </ol>

      <P>
        The rest of the reasoning lives beside the code: what the constraints are and why the code
        is shaped around them is in{" "}
        <Source href={`${REPO_URL}/blob/main/docs/GOTCHAS.md`}>docs/GOTCHAS.md</Source>, and what
        each concept is called is in{" "}
        <Source href={`${REPO_URL}/blob/main/CONTEXT.md`}>CONTEXT.md</Source> — one concept, one
        name, which is why the words on this page are the words in the source.
      </P>
    </>
  );
}
