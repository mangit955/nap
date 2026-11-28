# Dashboard and session list

The dashboard is where a signed-in user lands. A sidebar lists their sessions, newest first, with
search, a source filter, and per-row Snooze and Settle. The main area is the new-session composer,
and a Thread details panel sits on the right.

## Sub-features

- `list-show`: each session appears as a link with its source, title, diff counts and a status.
- `list-open`: choosing a session opens its workspace at `/p/<projectId>`.
- `list-search`: typing in Search sessions shows matching sessions in a listbox, with the match marked.
- `list-filter`: Filter by source opens a picker with All sources and one button per source.
- `list-settle`: Settle moves a session under a collapsed Settled group.
- `list-snooze`: Snooze hides a session until later.
- `list-new`: New session returns to the empty composer.
- `list-menu`: right-clicking a row opens the menu `Actions for <title>` (Pin, Settle, Snooze,
  Rename, Regenerate title, Archive, Delete and more).
- `list-retitle`: Regenerate title renames the session to the model's next title.
- `list-finished`: a session that finishes while another is open raises the toast `Session finished`,
  whose `Open` goes there; its row keeps a status `Unread` until it is opened.

## How to get to it (user POV)

- Sign in, which lands on `/dashboard`.
- Choose the `nap dashboard` link at the top of the sidebar from any page.
- Go to `/dashboard` directly.

## Driving it with verify-nap

Preconditions:

- Baseline state: signed in, with **Seeded notes app** in the list.

- **See the list.** Run `goto /dashboard`, then `snapshot --label "dashboard"`. The navigation
  `Dashboard` contains the region `Session list` and the list `Inbox sessions`, and that list
  contains a link whose name includes `Seeded notes app` and a status `Unread` (the row's blue dot).
- **Open a session.** Run `click --role link --name "Seeded notes app" --loose`. The URL becomes
  `/p/<seeded projectId>` (see `run.json`), and the main area shows the button
  `Rename this project. Currently called Seeded notes app` and the region `Chat`.
- **Search.** Run `goto /dashboard`, `fill --role combobox --name "Search sessions" --value "Seeded"`,
  then `wait --role option --name "Seeded notes app"`. The combobox reads `[expanded]`, and a
  listbox `Search results` holds the option `Seeded notes app` with `Seeded` marked. Close it with
  `press --key Escape`, then clear it with `fill --role combobox --name "Search sessions" --value ""`.
- **Filter by source.** Run `click --role button --name "Filter by source"`. The button reads
  `[expanded]`, and the panel shows the textbox `Search sources`, the button `All sources` (pressed)
  and the button `Scratch`.
- **Settle.** Run `hover --role link --name "<title>" --loose`, then
  `click --role button --name "Settle <title>"`. The row leaves `Inbox sessions`, a region
  `Settled` with the button `Settled (1)` appears. Check `wait --role button --name "Undo" --state hidden`,
  then capture it with `shot --label "session list: settled"`.
- **Session menu.** Run `click --role link --name "<title>" --loose --right`. A menu
  `Actions for <title>` opens with menuitems including `Pin`, `Settle`, `Snooze`, `Rename`,
  `Regenerate title`, `Archive` and `Delete`.
- **Regenerate title.** Do this on a session you started, whose row reads `Fixture title <nnn>`.
  First `snapshot` and note every `Fixture title` number in the list. In the row's menu, run
  `click --role menuitem --name "Regenerate title"`, then
  `wait --role link --name "Fixture title <nnn>" --loose --state hidden`; that wait passing is the
  proof. Then `snapshot` again: the row has a `Fixture title` number that was not in the list
  before, higher than all of them, because one counter numbers every title in the run.
- **Finished out of sight.** Run `click --role button --name "New session"`, fill
  `Describe the app you want`, `press --key Enter`, `wait --role region --name "Chat"`, then
  `click --role link --name "Seeded notes app" --loose` while the new one works. Run
  `wait --role dialog --name "Session finished" --timeout 60000`: the dialog's description is the new
  session's title, and its row holds a status `Unread`. Run `click --role button --name "Open"` at
  once: the URL becomes the new session's, its row has no `Unread`, and the dialog is gone. A turn
  that finishes in the session you are viewing raises no dialog.
- **New session.** Run `click --role button --name "New session"`. The main area shows the group
  `New session composer` with an empty `Describe the app you want`.

## Gotchas

- The `More actions for <title>` button is for touch screens only and is not in the tree on a
  desktop-sized window. Use the right-click above.
- Regenerating the seeded session's title renames **Seeded notes app**, which later recipes look
  for. Regenerate a session you started instead.
- Prove a retitle by the old name going, not by a new name appearing. A loose `Fixture title`, or
  the next number, can match another session's row straight away, so it proves nothing; with two
  matching rows the wait also fails as ambiguous.
- Each user may run four projects at once on the fixture, the seeded one included. Past that,
  Send shows the alert "You already have 4 projects running, which is the limit". Settling does
  not free a slot; choose `Put away workspace` in a project's menu first.
- A session left less than two seconds before its finish shows counts as watched, and raises no
  toast — only its dot. A fake turn lasts about 7.5 s, so switch away as soon as `Chat` appears;
  `snapshot` straight after the switch should show the new row's status `Working`.
- The `Session finished` toast closes itself after 8 seconds, and every driver command takes a second
  or two: click `Open` straight after the wait, with nothing in between. Its `Dismiss` button is
  hidden from the tree until the toast holds focus or the pointer, so `click --name "Dismiss"`
  cannot find it; reach it as a keyboard does, `press --key F6` then `Tab` three times and `Enter`.
- The Snooze and Settle buttons sit under the row's link until the row is hovered. Clicking them
  without hovering fails with "subtree intercepts pointer events".
- A row's link name includes its age and diff counts (`Scratch 3m Recipe Box +3 −1 scripted`), so
  match it with `--loose`.
- Search filters the visible list as well as the listbox. Clear it before you assert on the list.
- Results arrive after the session list has loaded. Snapshotting straight after `fill` can show the
  combobox with no listbox, so wait on the option.
- Settling is stored. Settle a session you created in this run, not **Seeded notes app**, unless
  the recipe that follows doesn't need it.
- `Filter by source` was driven open but not used to filter: only one source (`Scratch`) exists on
  the fakes, because importing a GitHub repository needs the GitHub App.
