# Start a project

A user describes an app in the dashboard composer and sends it. Nap creates a session, names it,
and moves to the workspace, where the first turn runs, files appear, and the preview comes up.

## Sub-features

- `start-send`: Send is disabled until the prompt has text; sending disables the composer.
- `start-navigate`: the workspace opens at once at `/p/new`, showing the prompt and `Starting your
  project…` where the composer goes, and the address becomes `/p/<projectId>` once the server has
  created the project.
- `start-title`: the session is named from the prompt at once, then renamed by the model's title
  (on the fakes, `Fixture title <nnn>`).
- `start-first-turn`: the first turn runs and ends with an answer and a Changed files card.
- `start-listed`: the new session appears at the top of the sidebar list.

## How to get to it (user POV)

- Type in `Describe the app you want` on `/dashboard`, then choose `Send`.
- The same, starting from `New session` in the sidebar on any page.
- The same, pressing Enter in the composer instead of choosing Send.

## Driving it with verify-nap

Preconditions:

- Baseline state, on `/dashboard`.

- **Empty composer.** Run `snapshot --label "start: empty composer"`. The group
  `New session composer` contains the textbox `Describe the app you want` and the button `Send` [disabled].
- **Type the prompt.** (The same works from `click --role button --name "New session"` on any page.) Run `fill --role textbox --name "Describe the app you want" --value "Build a recipe box"`.
  `Send` is enabled.
- **Send.** Run `click --role button --name "Send"`, or `press --key Enter`. The tab enters the
  workspace before the server answers; on the fakes the answer follows in well under a second, so a
  `shot` taken next usually already shows the project's own address. To see the pending state, slow
  the network (see Gotchas).
- **Workspace opens.** Run `wait --role region --name "Chat" --timeout 120000`, then `url`. The URL
  is `/p/<new projectId>`, and the button `Rename this project. Currently called …` shows the title.
- **First turn finishes.** Run `wait --text "Done. The newest message I read was" --timeout 60000`,
  then `shot --label "start: first turn done"`. The log `Transcript` holds `You: Build a recipe box`,
  a `Worked for …` button, the answer, and a region `Changed files` with `2 changed files`. The
  status `Job phase` reads `Verified`.
- **Titled.** In the same snapshot, the rename button reads `Rename this project. Currently called
  Fixture title <nnn>`, and the navigation `Dashboard` lists a link with that title above
  `Seeded notes app`.

## Gotchas

- Seeing the workspace before the project exists needs a slower network than localhost: with
  Chrome's network emulation at a few hundred ms (CDP `Network.emulateNetworkConditions`), the
  region `Conversation` shows the prompt, the status `Starting your project…` sits where the
  composer goes, and the URL is `/p/new` until `POST /sessions/start` answers. A refused start (the
  four-running-projects limit) goes back to `/dashboard`, where the composer shows the alert and the
  prompt.

- The first time a run opens `/p/…`, Next compiles the route, which can take 20 s or more on top of
  the turn. Wait on `Chat` with a long timeout instead of sleeping.
- The name changes twice: first to one derived from the prompt (`Recipe Box` for
  `Build a recipe box`), then, once the model answers, to `Fixture title <nnn>`. Match the title with
  `--loose` on `Fixture title`, or assert on the rename button, unless the change is to titling.
- "Test the app" stays disabled with "Choose a model that can view images." That is the fake model,
  not a bug.
- The fake writes `src/App.tsx` and `src/components/NoteList.tsx` only on the run's first turn.
  The seed turn uses that, so every turn you start writes `src/features/Change<n>.tsx` and
  `change<n>.css`, with `<n>` counting the run's turns.
