# File tree

The right panel's Files tab lists the project's files as a tree, marks the ones the session
changed, filters by name, and opens a file as a tab of its own. In the chat, each turn's
`Changed files` card lists what that turn wrote and opens the same files.

## Sub-features

- `files-tree`: folders are expandable buttons, files are buttons, and changed files are named
  `<file> changed`.
- `files-filter`: Filter files narrows the tree.
- `files-open`: choosing a file opens a tab named after it, with its path and contents.
- `files-card`: a turn's `Changed files` card shows `<n> changed files` with buttons `Open <path>`.

## How to get to it (user POV)

- In a workspace, choose the tab `Files` in the tablist `Workbench`.
- In the chat, choose `Open <path>` in a turn's `Changed files` card.

## Driving it with verify-nap

Preconditions:

- Baseline state, with **Seeded notes app** open (`click --role link --name "Seeded notes app" --loose`).

- **Tree.** Run `click --role tab --name "Files"`, then `snapshot --label "files: tree"`. The region
  `Files` holds the textbox `Filter files` and a list with `src` [expanded] > `components` [expanded]
  > `NoteList.tsx changed`, `App.tsx changed`, and `package.json`.
- **Filter.** Run `fill --role textbox --name "Filter files" --value "NoteList"`, then
  `snapshot --label "files: filtered"`. Only the path to `NoteList.tsx changed` remains, and a button
  `Clear the filter` appears. Clear it with `fill --role textbox --name "Filter files" --value ""`.
- **Open.** Run `click --role button --name "App.tsx changed"`, then `shot --label "files: App.tsx open"`.
  A new tab `App.tsx` is selected, holding the region `src/App.tsx (read-only)`, whose code starts
  `import { NoteList } from "./components/NoteList";`.
- **From the chat.** Run `click --role button --name "Open src/components/NoteList.tsx"` in the
  `Changed files` card. A tab `NoteList.tsx` opens, holding the region
  `src/components/NoteList.tsx (read-only)` with `<ul aria-label="Notes" />`.
- **A new turn's files.** After any follow-up on the fakes, the tree gains `features` with
  `Change<n>.tsx changed` and `change<n>.css changed`.

## Gotchas

- `changed` is part of a changed file's accessible name. `App.tsx` without it matches nothing in
  the tree.
- An open file is a tab of its own in `Workbench`, next to `Browser` and `Files`, and each has its
  own `Close <name>` button.
- On the fakes, files exist only in the in-memory sandbox for the life of the run.
