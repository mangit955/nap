# Nap verification map

These files are the source to keep up to date for verifying what a Nap user sees. Read this
index before driving the app, then use the matching feature file as your recipe. Each name in a
recipe came from an ARIA snapshot of a live fixture run, not from the source.

## Baseline preconditions

- A fixture from `bun run verify-nap:up` is running, and `bun run verify-nap doctor` prints `ok`
  on every line.
- `bun run verify-nap signin` has landed on `/dashboard` as `verify@nap.test`.
- The session list holds **Seeded notes app** (status `Done`), whose files are `src/App.tsx`,
  `src/components/NoteList.tsx` and `package.json`.
- Every project previews the same static page. Its iframe is titled `App preview`, and inside it
  are the heading `Fixture notes`, a button `Add note` and a list `Notes`.
- Never drive a fixture this run didn't start, and never point the driver at a real deployment.

## Driving conventions

- Every command below is `bun run verify-nap <command>`, written here without the prefix.
- Target by role and accessible name. If a name is missing from a recipe, run `snapshot` and copy
  it from the tree.
- Matching is exact. Add `--loose` only where a recipe does, which is for names that include a
  changing part (a session row's link name includes its age, for example `Scratch 3m Recipe Box +3 −1`).
- Rows reveal their buttons when hovered. `hover` the row's link before you click `Snooze <name>`
  or `Settle <name>`.
- Wait for an observable state (`wait --role … --state hidden`, `wait --text …`), not a fixed sleep.
  Each turn takes about 7.5 s.
- Mutations persist for the life of the run. A recipe that settles or renames a session leaves it
  changed for the next recipe, so run those last or start a new fixture.

## Proof and skip reporting

- Capture the action and its result. Use `shot --label "<feature>: <state>"` at each labelled step
  in the recipe.
- A UI proof needs a PNG and an ARIA tree from the same moment; `shot` writes both.
- For a change to stored state (a file written, a session settled), the proof also needs a second,
  read-only view of it: the Files tab, a reload, the Settled group.
- Record which entry point you drove. If an entry point couldn't be reached, report the command you
  tried and the precondition that failed; don't report it as verified through another path.

## Feature entry contract

Each feature file starts with an H1 and a paragraph describing what the user sees. Four H2s follow
in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-nap` (which
starts with `Preconditions:`), and `Gotchas`.

## Features

- [Sign in and sign up](./auth-pages.md): the two modes, the switch between them, email sign-up,
  the guest door, the expired-session notice and a refused sign-in.
- [Dashboard and session list](./dashboard-and-session-list.md): listing, search, source filter,
  settle and snooze, opening a session.
- [Start a project](./start-a-project.md): the dashboard composer creates a session and runs its
  first turn.
- [Workspace chat and steering](./workspace-chat.md): follow-ups, the live turn, steering a running
  turn, stopping one.
- [Preview pane](./preview-pane.md): the Browser tab, its address bar and reload, and interacting
  with the previewed app.
- [File tree](./file-tree.md): the Files tab, filtering, opening a file, and the changed-files card
  in the chat.
- [Docs](./docs.md): the docs home, a page, its sidebar and "On this page", search, old
  `/docs#<id>` links, and the phone layout.
- [Model picker](./model-picker.md): the line and effort a turn runs on, the key form a locked line
  opens, and the version a turn is queued on.

Not mapped yet: settings (`/settings/*`), plan mode, the diff view, Test the app, archived
sessions. Add a file for each one the first time a change touches it.
