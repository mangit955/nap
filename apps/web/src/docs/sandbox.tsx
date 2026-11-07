/**
 * The machine the agent works on, and what happens to it when nobody is looking.
 *
 * The sandbox tools and the reaper are one section rather than two because they are the same
 * argument from two ends: the agent can only reach the sandbox, and the sandbox is disposable.
 * Either alone is half of why walking away is safe.
 */

import { REPO_URL } from "../landing/github-button.tsx";
import { Code, Facts, Figure, Lede, P, Source, Sub, Term } from "./prose.tsx";

const TOOLS = `read      read_file
edit      write_file · edit_file · apply_patch (GPT models)
search    list_files · glob · search_files
execute   run_command · shell_output · shell_input · shell_kill
plan      todo_write · propose_plan (plan mode)
ask       ask_user
delegate  run_subagent · read_subagent (imported repositories)
computer  computer (image models, when a desktop is composed)
skill     skill (the project's own instruction packs)

file, search and command tools proxy to SandboxManager.
a helper is a second loop over the same ports, inside the turn's budget;
with Fusion on, a search helper runs on the sidekick.`;

export function Sandbox() {
  return (
    <>
      <Lede>
        A <Term>sandbox</Term> is the isolated machine a project&rsquo;s code is written into and
        served from. It is reclaimable at any time — which is a design constraint, not a caveat.
      </Lede>

      <Sub>Tools run behind project ports</Sub>

      <P>
        A batteries-included agent SDK ships built-in file and shell tools, and those act on the
        filesystem of the process running the harness — which here is one of our own server
        processes, not the user&rsquo;s sandbox. So <Code>AgentService</Code> drives the model loop
        itself over an <Code>LLMProvider</Code> port. File and command tools use{" "}
        <Code>SandboxManager</Code>. The <Code>computer</Code> tool uses <Code>SandboxDesktop</Code>{" "}
        and object storage, and is offered only for image-capable models when desktop access is
        configured. The desktop template still needs paid validation.
      </P>

      <Figure label="The whole tool surface, by what each tool is for.">{TOOLS}</Figure>

      <P>
        Not every turn is offered all of it. A turn&rsquo;s tools follow from facts about it: an app
        test can only look, a repair has nobody to answer a question, and a model is offered the
        editing format it was trained on. Reads run side by side; anything that changes the project
        runs alone, in order. A file has to be read in a turn before that turn may change it.
      </P>

      <P>
        A person can also ask for a plan first. A turn sent in <Term>plan mode</Term> is offered
        only the tools that look: file reads, searches, questions, and helpers that cannot write,
        plus <Code>propose_plan</Code>. The narrowing is enforced when a call runs, not only in what
        the model is shown. Edits and commands are refused and logged. Even a command that looks
        like a read may run a program chosen by the repository's configuration, so planning uses the
        dedicated file tools instead. The turn ends on the proposal (a title and up to 12,000
        characters of Markdown), opens no job, commits nothing and is not snapshotted. If the model
        tries to stop without proposing, it is reminded once.
      </P>

      <P>
        The plan appears in the chat as a card. Approving it sends a message naming the turn that
        proposed it; that turn opens a job named for the plan, and every turn of the job, repairs
        included, carries the approved plan in its turn context, never cut to fit. Asking for
        changes sends another plan mode message, and so does answering a question the planning turn
        asked. Whether a plan is waiting, approved, revised or set aside is not stored anywhere: it
        is whatever the next message did, folded from the event log. The card and the server both
        use that fold, so an approval of a plan that has already been settled is refused on
        admission and again under the lease, and settles nothing. If the turn that approved a plan
        fails, the plan waits again and can be approved again, unless a newer request has replaced
        it.
      </P>

      <P>
        A project can carry <Term>skills</Term>: folders holding a <Code>SKILL.md</Code>, whose
        frontmatter gives a name and one line on when to use it, and whose body is instructions for
        that kind of work. They are looked for in <Code>.nap/skills/</Code>, then in the{" "}
        <Code>.agents/skills/</Code> and <Code>.claude/skills/</Code> folders an imported repository
        may already have, one folder deep, through the sandbox port like every other read. That is
        three directory listings in parallel, then up to 32 skill reads in parallel, at the start of
        each turn, with a five-second deadline. At most 32 are read; a description may be 500
        characters and a whole file 24,000. A skill that breaks a rule, or repeats a name an earlier
        folder already used, is skipped and its reason shown. Excess-folder warnings name at most 32
        folders and count the rest, so diagnostics stay bounded. Each reason is capped at 500
        characters. A sandbox that cannot answer makes the skills unavailable for that turn rather
        than absent. Nothing about a skill fails a turn.
      </P>

      <P>
        The agent sees only the names and descriptions, at the end of the turn&rsquo;s own message
        beside the file listing, so a skill added or edited mid-session changes nothing a provider
        has cached. They are the first thing given up after the file listing when a turn runs short
        of room. The <Code>skill</Code> tool loads one by name, reading it fresh, and looks again if
        the name is new since the turn began. Its instructions are framed as the project&rsquo;s
        guidance, below Nap&rsquo;s own: a skill may come from a repository anybody wrote. For the
        same reason it grants nothing. An <Code>allowed-tools</Code> list narrows the rest of the
        turn to the tools it names that the turn already had, a second skill narrows what the first
        left, and an entry Nap cannot enforce, such as a command limited to some arguments, grants
        nothing at all. Asking the person, keeping the checklist, proposing a plan and loading
        another skill stay available. The log records which skills a turn found, only when that
        changed, and which one each call loaded. Plan mode can load skills; helpers and app tests
        cannot.
      </P>

      <P>
        A message sent while a turn is running <Term>steers</Term> it rather than waiting behind it.
        The message is admitted like any prompt, with the same ownership checks, model access,
        sandbox quota and rate limit, and charged whatever becomes of it. It then waits in a row
        joined to the running request. The agent reads it only at a step boundary: once the last
        batch of tool calls has been answered, or when the model stops with a step left. It is
        appended after those results, never between a result and its call, and never into the cached
        part of the conversation. The log records it where it was read, durably, before the model
        sees it. It is read only with room left to answer it: a step to spare, and a next request
        that still fits the turn&rsquo;s budget; otherwise it waits for the turn to end. At most
        three wait on one turn; a fourth is queued as the next turn. A turn that finishes without
        reading a message queues it as the next turn, under the same id. A turn that was stopped
        runs none of them, and neither does one whose worker died or shut down first; each is
        offered back to send again. Some running work never takes a message — a compaction, an app
        test, a publish, or a turn in the other plan mode — and a message sent to it is the next
        turn. Whether a message joins the turn or becomes the next one is decided under a lock on
        the running request&rsquo;s row, which the turn&rsquo;s end takes too. A retried message is
        admitted only after the attempt before it has committed, under a lock on its id, so one
        message lands once, as a steer or as a turn. Each later change to a message is one
        conditional update, so none is read twice. A message can still go unanswered if the
        turn&rsquo;s end fails to record, or if the record of reading it is lost on the way back;
        once the session is idle, the chat offers it back.
      </P>

      <P>
        A deployment can pair the model a turn runs on, the <Term>lead</Term>, with a cheaper{" "}
        <Term>sidekick</Term>. This pairing is called <Term>Fusion</Term>, and it is off unless the
        deployment names a sidekick. The sidekick only condenses: it runs the helpers that search,
        and it writes compaction summaries. Both produce text that only the lead reads, and the lead
        can recover what that text leaves out by reading the files or searching the saved history.
        Everything that changes the project or answers the person stays with the lead, including
        helpers that edit. The sidekick runs only on turns the deployment pays for, which today are
        the free tier&rsquo;s turns on the deployment&rsquo;s demo model. On a person&rsquo;s own
        key every request goes to the model they picked, and a turn on a free model has no sidekick,
        which could only add cost to it. The sidekick&rsquo;s tokens come from the same turn budget
        and appear in the turn&rsquo;s usage. A summary is offered to the sidekick only when the
        budget could also pay for the lead to write it and, if the turn goes on, for the
        lead&rsquo;s next request. If the sidekick refuses, errors, returns something that is not a
        complete summary, or takes more than two minutes, the lead writes the same summary. After
        one such failure, the lead writes every later summary in that turn. A search helper that
        fails reports the failure to the lead, which can search for itself. The lead&rsquo;s tool
        block and system prompt, the prefix its cache reads, are unchanged, so its cache is
        unaffected.
      </P>

      <P>
        A command that keeps running — a server, a watcher — runs as a background shell whose
        output, exit code and process group are files in the sandbox. The agent comes back to it by
        id, and it outlives the turn that started it, because nothing about it lives in our
        processes.
      </P>

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
            term: "The ceiling is claimed where the sandbox is made",
            body: "A queued turn may not create anything for a minute, so counting sandboxes at admission counts the wrong moment. Capacity is reserved at creation, and the reaper reconciles it against what the provider says it is actually running — which is how a slot no path gave back comes back in minutes rather than never.",
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
