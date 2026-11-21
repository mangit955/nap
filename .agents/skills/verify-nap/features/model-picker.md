# Model picker

The composer's model control, in the dashboard and the workspace. The trigger names the line a turn
will run on, with its effort as rising bars (or `Max` written out). It opens T3 Code's three
columns: a vendor rail, the lines of the chosen vendor with a `New` badge on recent versions, and an
effort column. Lines a caller cannot run stay listed and open the key form instead.

## Sub-features

- `picker-free`: with no key, only the free tab's model is runnable; every line says `needs your
  key`, and the effort column says `Set by this deployment`.
- `picker-key`: a locked line opens the `Your API key` dialog; once a key is saved, the trigger reads
  `Sol` at `Medium` and every line is runnable.
- `picker-line`: choosing a line keeps the popup open on the effort column.
- `picker-effort`: choosing a level closes the popup and shows the level on the trigger.
- `picker-sent`: the next turn is queued on the line's version at that effort.

## How to get to it (user POV)

- `Model` in the dashboard's composer, before starting a session.
- `Model` in the workspace composer, for the next turn.

## Driving it with verify-nap

Preconditions:

- Baseline state, on `/dashboard`.

- **Keyless.** Run `click --role button --name "Model"`, then `click --role button --name
  "Anthropic"`. Each line's button name ends `needs your key`; the radiogroup `Effort` holds the
  paragraph `Set by this deployment`. Run `shot --label "picker: keyless"`.
- **Save the fixture's key.** Run `click --role button --name "Opus" --loose`. The dialog `Your API
  key` opens. Run `fill --role textbox --name "API key" --value
  "sk-or-v1-verify-nap-fixture-key-FAKE"` and `click --role button --name "Save key"`, then `click
  --role button --name "Close"`. The trigger's text becomes `Sol, Medium effort`. The fixture accepts
  this one made-up key and no other; turns still run on the scripted model.
- **Line, then effort.** Run `click --role button --name "Model"`, `click --role button --name
  "Anthropic"`, `click --role button --name "Opus" --loose`. The popup stays open; run `shot --label
  "picker: effort column"`. Then `click --role radio --name "Max"`. The trigger reads `Opus Max`.
- **Sent.** Send a message from either composer and wait for the answer. The sidebar card names the
  version the turn ran on (`claude-opus-5.5`).

## Gotchas

- The rail shows one vendor at a time. A line in another vendor's tab is not in the tree until that
  tab is chosen, or `Search models` is typed into.
- The Next dev badge covers the sidebar's `Settings` button in a dev run, so reach the key form from
  a locked line rather than through Settings.
- After the fixture's key is saved, `doctor` still passes: it accepts lines only under that key.
