# Command palette

⌘K (Ctrl+K off a Mac) opens a palette over the dashboard or a workspace. It lists actions, then
sessions; typing filters both, arrows move the highlight, Enter runs it and Escape closes.

## Sub-features

- `palette-open`: the dialog `Command palette` holds the combobox `Search commands and sessions`
  and the listbox `Commands`, with groups `Actions` and `Sessions`.
- `palette-actions`: a workspace offers `New session`, `Toggle sidebar`, `Open Files`,
  `Open Browser` and `Show changed files`; the dashboard offers only the first two.
- `palette-filter`: typing `file` leaves the options `Open Files` and `Show changed files`.
- `palette-run`: Enter runs the highlighted option and closes the dialog.
- `palette-focus`: Escape closes it and focus returns to where it was.

## How to get to it (user POV)

- Press ⌘K anywhere on `/dashboard` or `/p/<id>`. Pressing it again closes the palette.

## Driving it with verify-nap

Preconditions:

- Baseline state, with **Seeded notes app** open (`click --role link --name "Seeded notes app" --loose`).

- **Open.** Run `press --key "Meta+k"` (the fixture's Chrome is on a Mac; elsewhere `Control+k`),
  then `snapshot --label "palette: open"`. Expect the dialog and both groups above.
- **Filter and run.** Run `fill --role combobox --name "Search commands and sessions" --value "file"`,
  `snapshot --label "palette: filtered"` (expect `Open Files` [selected] and `Show changed files`),
  then `press --key Enter` and `wait --role tab --name "Files"`.
- **Focus back.** `click --role textbox --name "Message"`, `press --key "Meta+k"`,
  `press --key Escape`; the composer has focus again. The driver cannot read focus; check it with
  `document.activeElement` over the run's DevTools port, as `docs/assets/command-palette/` did.

Timing and reduced motion are not visible to the driver; `docs/assets/command-palette/README.md`
records how they were measured.
