# ADR-0037 — Opening a project starts nothing

**Status:** Accepted, 2026-11-19. Reverses the start on arrival added in commit `29cabbff` ("start a
project on arrival"), which no ADR recorded. Amends [ADR-0006](0006-a-completed-turn-is-a-claim-not-a-fact.md)
on what counts as a person opening a project. Built and tested on the web app's fakes and driven in
the real web app on a fake model and sandbox. No real sandbox was started for it.

## Context

Since `29cabbff`, the workspace page sent `POST /projects/:id/open` as soon as it loaded a project
whose record said it was put away. The reasoning in that commit was that nobody navigates to their
own app to be asked whether they meant it, so the Resume button became a fallback for a refused
start.

That made looking at a project the same as using it, and it showed in two places:

- **Every project opened took a sandbox slot.** `/open` is admitted against the same sandbox ceiling
  as a turn, so browsing through a few put-away projects filled the ceiling. The next project the
  person actually wanted to work on was then refused.
- **An opened project jumped to the top of the sidebar with "now".** Measured on production: with
  `/open` blocked, opening two put-away projects left the sidebar order unchanged; with it
  unblocked, the opened project moved to the top.

## Decision

**Opening a put-away project shows it and starts nothing.** The preview pane shows the project's last
snapshot, dimmed and labelled as not live, with the put-away message and a Resume button. The chat is
there as usual. Two things start the workspace:

- **Sending a message.** The turn's own acquire step restores the snapshot into a new sandbox
  (`acquire-sandbox.ts`, through `openProject`), so the composer sends the turn and nothing else. No
  `/open` is sent first; it would be a second request competing with the turn for the same session.
- **Pressing Resume**, for somebody who wants the running app without asking for a change. This is
  `/open`, unchanged.

The phase rule that drew a put-away project as *starting* until the auto-start's request went out is
gone with it (`project-phase.ts`). A put-away record with no request in flight is now the put-away
phase.

## Consequences

- **ADR-0006's "a person opening the project" now means pressing Resume.** A job left open by a
  process restart is continued by `resumeSession`, which only `/open` runs. While the auto-start
  existed, navigating to the project was enough to continue it. Now the person has to press Resume.
  ADR-0006's argument still holds: a person is there to watch either way, and nothing continues on
  its own. The janitor's wording in `CONTEXT.md` ("waits for a human to reopen the project") reads
  the same way.
- **Seeing the running app takes one more action.** That is the cost the earlier commit was avoiding.
  It is accepted because the alternative spends the person's sandbox ceiling on every project they
  look at.
- **The restore wait starts when somebody acts, not on arrival.** The same start-up screen and ghost
  are shown once it does.

## Rejected

**Keep the start on arrival and stop it touching the sort order.** That fixes the sidebar but not the
slots: a restore is a sandbox, and the ceiling is on sandboxes.

**Start on arrival only while there is a free slot.** That needs the browser to know the person's
quota before asking. It would also still use up the last free slot on a project the person only
opened to look at.
