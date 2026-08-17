/**
 * The machine the agent works on, and what happens to it when nobody is looking.
 *
 * The six tools and the reaper are one section rather than two because they are the same
 * argument from two ends: the agent can only reach the sandbox, and the sandbox is disposable.
 * Either alone is half of why walking away is safe.
 */

import { REPO_URL } from "../landing/github-button.tsx";
import { Code, Facts, Figure, Lede, P, Source, Sub, Term } from "./prose.tsx";

const TOOLS = `read_file      write_file     edit_file
list_files     search_files   run_command

every one of them proxies to SandboxManager.
there is no seventh, and no filesystem but the sandbox's.`;

export function Sandbox() {
  return (
    <>
      <Lede>
        A <Term>sandbox</Term> is the isolated machine a project&rsquo;s code is written into and
        served from. It is reclaimable at any time — which is a design constraint, not a caveat.
      </Lede>

      <Sub>No agent harness, and the six tools are the reason</Sub>

      <P>
        A batteries-included agent SDK ships built-in file and shell tools, and those act on the
        filesystem of the process running the harness — which here is the API server, not the
        user&rsquo;s sandbox. So <Code>AgentService</Code> drives the model loop itself over an{" "}
        <Code>LLMProvider</Code> port, and the only tools that exist are these six.
      </P>

      <Figure label="The whole tool surface.">{TOOLS}</Figure>

      <P>
        That is stronger than disabling built-ins, because there is no toggle to get wrong. It is
        also what makes an unattended agent something you can walk away from: there is no reachable
        filesystem but its own.
      </P>

      <Sub>An idle project is snapshotted, not paused</Sub>

      <P>
        Keeping a sandbox alive so a project stays openable means paying for a machine nobody is
        using. So a reaper commits the workspace, bundles the git repository to object storage and
        destroys the sandbox. Restore is the inverse, and takes seconds. That turns &ldquo;come back
        tomorrow&rdquo; from a billing problem into a cold start.
      </P>

      <P>
        A project in that state is <Term>put away</Term>: not an error and not an empty project, but
        the state a project spends most of its life in. The bytes and the bookkeeping are separate
        ports because they fail independently, and teardown ordering is only expressible if they do.
      </P>

      <Facts
        items={[
          {
            term: "A checkpoint and a snapshot are different things",
            body: "A checkpoint is about whether the work is sound; a snapshot is about where the work is kept. One is a verified commit, the other an archived filesystem.",
          },
          {
            term: "A preview is identified by an event, not a URL",
            body: (
              <>
                The <Code>seq</Code> of the <Code>preview.ready</Code> that announced it. A project
                put away and restarted has two announcements and only one live sandbox — so no view
                may read &ldquo;there is a <Code>preview.ready</Code> in the log&rdquo; as
                &ldquo;something is running&rdquo;.
              </>
            ),
          },
          {
            term: "Somebody else's project answers 404",
            body: "Not 403 — a 403 confirms the row exists, which is itself a fact about someone else's data. The authorization filter lives in the query rather than in a handler that might forget it.",
          },
        ]}
      />

      <P>
        <Source href={`${REPO_URL}/tree/main/packages/agent/src/tools`}>
          packages/agent/src/tools
        </Source>
      </P>
    </>
  );
}
