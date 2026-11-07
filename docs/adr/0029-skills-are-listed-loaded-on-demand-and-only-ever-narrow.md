# ADR-0029 — Skills are listed every turn, loaded on demand, and only ever narrow

**Status:** Accepted, 2026-11-07. Built and tested on fakes, the in-memory sandbox, the context engine's stub sandbox and a real Postgres. No real model and no real E2B sandbox has run it, so whether models load a skill when its description matches, and what discovery costs against a real sandbox, are unmeasured. Follows the harness work of ADR-0020, ADR-0024, ADR-0025 and ADR-0028.

## Context

A project often has instructions an agent should follow only for some of its work: how migrations are made here, what a component must look like, which script seeds the database. Put in the system prompt, they cost tokens on every request of every turn, most of which never need them. Left out, the agent rediscovers them by reading the tree, or does not.

Devin's local harness finds skills in the repository, lists them in the prompt and has a tool that loads one, and that was the feature reference. The design, wording and code here are Nap's own. Four facts about Nap shape them:

1. **The project's files live in a sandbox, not on the host running the agent.** Every read goes through `SandboxManager`, and costs a round trip.
2. **The cached prefix is never rewritten (ADR-0024).** The tool block and the system prompt head every request, and a session that changes either pays for its whole prefix again.
3. **A skill is repository content, and repositories are imported from anywhere.** Anything it says is untrusted in the way a README is.
4. **The event log is the source of truth (ADR-0008).** What the pane shows of a skill must fold from events.

## Decisions

### D1: Where skills live, and what makes one

A skill is a folder holding a `SKILL.md`, exactly one level below one of three roots, in precedence order:

1. `.nap/skills/` — Nap's own.
2. `.agents/skills/` — the cross-harness convention.
3. `.claude/skills/` — the convention many repositories already carry.

The two conventions are honoured so an imported GitHub repository's skills work without being moved. Nap's own folder comes first so a project can override a skill it imported under the same name: the first skill with a name wins, and a later one is skipped with the path of the one that won. A `SKILL.md` anywhere else in the tree is documentation, not a skill.

`SKILL.md` opens with YAML frontmatter, parsed by `yaml` with aliases off and duplicate keys refused, and validated by Zod:

- `name` — 1–64 characters, letters, digits, `.`, `_` and `-`, starting with a letter or digit. Nothing a path can be built from, because the tool is called with it.
- `description` — 1–500 characters, folded to one line. It is about *when* to load the skill.
- `allowed-tools` — optional; a string (split on commas, or on spaces when there are none, never inside parentheses) or a list. See D4.

Unknown keys are dropped, not refused: other harnesses write `license`, `metadata` and their own settings into the same files, and refusing those would skip most imported skills over keys that mean nothing here. A body is required.

**`yaml` became a shipped dependency of `@nap/shared`.** A hand-rolled frontmatter reader would disagree with every other harness on the edge cases (folded strings, quoting, flow lists), and these files are written for those harnesses first. The library was already in the workspace.

### D2: Bounds, and a skill never fails a turn

- At most **32 skills** are read. Every listed skill costs its description on every turn, and a repository with more is better served by fewer, broader ones. The rest are skipped by name, in path order.
- A description of at most **500 characters**.
- A whole `SKILL.md` of at most **24,000 characters**, which stays under the 30,000-character tool output cap with the framing the tool adds, so a loaded skill is never cut off mid-instruction. Longer detail belongs in files beside it, which the agent reads when the instructions send it there.
- Discovery takes at most **5 seconds**, the file listing's deadline.

A malformed, duplicate, oversized or unreadable skill is **skipped with a reason** a person can act on: the listing tells the agent, and the work log shows a warning. A folder with no `SKILL.md` is a folder of shared files and is passed over in silence. A sandbox that cannot answer makes the skills **unavailable** for that turn, said in the listing, rather than absent: a slow sandbox must not read as a project with no skills, or record them as removed. Nothing about a skill fails a turn.

### D3: Discovery runs at the start of each turn, and the listing rides in the turn's own message

Discovery is three single-level `listFiles` calls and one `readFile` per skill, all in parallel, alongside the file listing in `ContextEngine.build`. That is once per turn, never per model step. It is not a walk and not a command, so it works against every fake and costs one round of requests. A compaction's rebuild runs it again, which is rare and cheap.

The listing — names and descriptions, under `<project_skills>` — goes at the end of the turn's own message, beside the file listing, in the **turn context**. That is the one place ADR-0024 lets change from turn to turn. So a skill added, edited or removed mid-session reaches the next turn, and costs no cache: the system prompt and the tool block never mention any skill. A project without skills adds nothing to the prompt at all.

On a turn short of room, the skill listing is given up **after the file listing and before memories**. It is smaller than the file listing and cannot be rebuilt with one call, but the `skill` tool still loads any name the agent already knows.

The rejected alternatives:

- **Discovery on every step.** It would put a round of sandbox calls before every model request, for a listing that changes perhaps once a session.
- **The system prompt, or the `skill` tool's description.** Both head the cached prefix, so every skill edit would cost the session its cache.
- **Appending a notice when a skill changes mid-turn.** Nothing in a turn reads skills except the tool, which reads fresh (D5). A turn sees the listing it started with, and the next turn sees the new one.

### D4: Trust — guidance below the system prompt, and narrowing only

A skill's body comes from the repository. It is framed as the project's guidance: the listing says its descriptions are "the project's own words", and a loaded skill arrives inside `<skill>` with a preamble saying the system instructions take precedence where they conflict. Text that could close the section it sits in is removed.

**A skill grants nothing.** `allowed-tools` is read into Nap's tool names (common harness names such as `Read`, `Grep` and `Bash` map onto Nap's equivalents), then **intersected** with what the turn was offered and with any narrowing already in force. After that, a call to any other tool is refused, logged as a call with a refused result, exactly as an unoffered tool is. The safe reading of anything unclear is always the smaller one:

- An unknown name grants nothing.
- A scoped entry such as `Bash(git status:*)` grants nothing. Nap cannot hold a tool to some of its arguments, and granting the whole tool would be wider than the author asked for. Both kinds are named back to the agent as "not granted".
- A second skill narrows what the first left; nothing ever adds a tool back within a turn.
- The check runs after the turn's own offer, so a skill can add a refusal but never lift one. A plan mode turn stays read-only whatever a skill lists.

Five tools stay callable however narrow a skill makes the turn, because none of them touches the project and losing them would strand it: `skill`, `todo_write`, `ask_user`, `propose_plan` and `read_subagent`. A skill that lists only `Read` must not leave a planning turn unable to propose, or a turn unable to collect a helper it started.

Narrowing lasts for the rest of the turn and no longer. It lives on a per-turn `SkillSession` the agent service holds beside the file ledger, because a tool's context is rebuilt for every call.

### D5: The `skill` tool

`skill` is appended to `TOOL_NAMES`, declared in `definitions.ts` with one argument, `name`, validated by the same schema as the frontmatter, and handled in `tools/skill.ts`.

It looks the name up in the index the turn started with, then **reads the file fresh**, so an edit since the turn began is what gets loaded. If the name is not in the index, or the file at the indexed path is gone or now says another name, it runs discovery once more and tries again; only a miss pays for that. It returns the body and the skill's folder, so the agent can read the files the instructions name. A failure says why: the names that do exist, or the reason a skipped skill was skipped.

It runs alone, never beside reads, because loading one changes what the next call may do.

**Who is offered it:**

- **Every turn a person or a check started, whether or not the project has skills.** The tool block is the head of every cached prefix (ADR-0024). Offering `skill` only once a project had skills would make the session's first skill rewrite its cache.
- **Plan mode, yes.** It only reads, and a plan should follow the project's own instructions for the work it plans.
- **Helpers, no.** A helper sees none of the turn's conversation and gets a self-contained task; the parent puts whatever a skill says that matters into the task. A helper with its own index and narrowing would be a second skill session per turn for little gain.
- **App tests, no.** Their tool set is fixed to looking at the running app.

### D6: Two events

- `skills.discovered { skills: [{ name, description, path }], skipped: [{ path, reason }] }` is written **right after `turn.started`**, only when it differs from the last one in the session. The engine decides that, because it is handed the log; the agent writes the event, because every event after `turn.started` is the agent's. So a session that never touches its skills records them once, and a skill added, broken or removed is visible on the turn where it happened. A project with no skills never records anything, and an unavailable index is never news. It is not written on a compaction, which runs no tools; the next turn finds the same difference.
- `skill.loaded { toolCallId, name, path, allowedTools }` is written between the `skill` call and its result. It has its own event, as `plan.updated` does, so the pane names the skill without trusting the call's arguments. `allowedTools` is the set after intersection, or `null` when the skill narrowed nothing.

Nothing replays from either event into the model's context; the agent is told the current skills on every turn regardless.

The turn log records counts, and the loaded skill's name and the tools it narrowed to, never descriptions or reasons, which are repository text.

### D7: The pane, the harness and the docs

The work log folds `skill.loaded` onto its call's row, opening an orphan row for a client that joined after the call, as `subagent.started` does. The row reads "Used skill *name*", groups as "Used N skills" with a book icon, and opens to the skill's path, what it narrowed the turn to, and the instructions the agent received. `skills.discovered` becomes a notice: the skills found, and a warning naming each skipped file and why.

`bun run harness` seeds its in-memory project with `.nap/skills/react-components/SKILL.md` and scripts a `skill` call, so the free dry run shows discovery, the event and the load. The `/docs` sandbox section describes the mechanism, and `CONTEXT.md` defines **Skill**.

## Consequences

- A repository's skills work in Nap as they are, from either convention.
- Every turn pays three directory listings, plus one read per skill, in parallel. On a project with none, all three listings come back not-found.
- A skill can make a turn safer and never more capable. The cost is that a skill author who meant a scoped `Bash(...)` grant gets no `run_command` at all, and is told so.
- The context engine's stub sandbox now allows exactly what discovery needs: listing the three skill roots, and reading a `SKILL.md`. Every other listing and every other read still throws, so a regression that makes context assembly read the project's files is still caught.

## Unverified

Only real infrastructure can settle these:

- Whether real models load a skill when the work matches its description, and follow its instructions.
- What discovery costs against E2B. Three listings and N reads in parallel should fit well inside the five-second deadline, but it has not been timed.
- That the E2B adapter's `listFiles` on a missing folder maps to `file_not_found`, as the code reads it, on every path the template produces. The mapping was read in the adapter, not observed.
- How E2B's `listFiles` reports a skill folder that is a symlink. It may come back as a file, which would make that skill invisible.
