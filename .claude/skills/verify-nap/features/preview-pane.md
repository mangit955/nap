# Preview pane

The right panel's Browser tab shows the running app in an iframe, with an address bar, a reload
button and a link that opens it in a new tab. The chat also announces `Preview ready · <host>` when
the preview comes up.

## Sub-features

- `preview-shown`: the tab `Browser` holds the textbox `Page to show`, the button `Reload the preview`,
  the link `Open the preview in a new tab`, and the region `Preview` with the iframe `App preview`.
- `preview-interact`: the previewed app responds inside the iframe.
- `preview-announced`: the transcript says `Preview ready ·` with a link to the preview host.
- `preview-panel`: Hide right panel, Close right panel and Hide chat change the layout.

## How to get to it (user POV)

- Open a workspace that has run a turn. The right panel opens on the `Browser` tab.
- Choose the tab `Browser` in the tablist `Workbench`.
- Choose the link `Open the preview in a new tab`, which opens the host directly. The driver acts
  on one tab only, so it can check this link's address but cannot follow it; report it as not driven.

## Driving it with verify-nap

Preconditions:

- Baseline state, with **Seeded notes app** open (`click --role link --name "Seeded notes app" --loose`).

- **Pane shown.** Run `click --role tab --name "Browser"`, then `snapshot --label "preview: pane"`.
  The tabpanel `Browser` holds `Page to show`, `Reload the preview`, `Open the preview in a new tab`
  (its URL is the run's `preview` from `run.json`) and the region `Preview`.
- **Inside the app.** Run `snapshot --label "preview: app" --frame "App preview"`. The tree is the
  heading `Fixture notes`, the button `Add note` and the list `Notes`.
- **Interact.** Run `click --role button --name "Add note" --frame "App preview"`, then
  `wait --text "Note 1" --frame "App preview"` and `shot --label "preview: after add note"`. The list
  holds `Note 1`.
- **Reload.** Run `click --role button --name "Reload the preview"`, then
  `wait --role heading --name "Fixture notes" --frame "App preview"` and
  `snapshot --label "preview: reloaded" --frame "App preview"`. The list `Notes` is empty again,
  because the page reloaded.

## Gotchas

- The page snapshot stops at the iframe and shows only `- iframe`. Use `--frame "App preview"` to see
  inside it.
- While a preview is being replaced, two iframes share the title `App preview`. The outgoing one is
  `aria-hidden`, and `--frame` skips it.
- The previewed app is a static page from the fixture, the same for every project. It proves the
  pane works, not what the agent built. On the fakes, the preview never reflects the files a turn wrote.
