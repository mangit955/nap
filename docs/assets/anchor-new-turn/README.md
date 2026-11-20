# Anchoring a sent message: verify-nap captures

Taken with `bun run verify-nap:up` (fake model and sandbox, real web app, API, worker and Postgres) in
headless Chrome at 1440×813, on the branch `feat/anchor-new-turn`. Shot 6 was taken after rebasing onto
the merge of #305, which draws a new project's first prompt through `StartingWorkspace`; the others
were taken on the same change before that rebase, which touched no scroll code. Positions were read from the live
page with a probe attached to the same Chrome: `scrollTop`, the box's furthest scroll, and the newest
prompt bubble's distance from the top of the conversation box.

| File | What it shows | Measured |
|---|---|---|
| `1-right-after-send.png` | The first frame after Send: the message at the top, the reply starting below | prompt 24px from the top |
| `2-mid-stream.png` | Mid-turn, with reasoning, prose and a file edit under the message | prompt 24px from the top |
| `3-short-reply.png` | A finished turn shorter than the view: end space keeps the message at the top | prompt 24px from the top, 48px of end space left |
| `4-scrolled-up-mid-stream.png` | A real mouse wheel 250px up mid-turn: the view stays there to the end of the turn | `scrollTop` 454 throughout, furthest scroll 704 |
| `5-steer-in-view.png` | A message sent into the running turn, drawn at the end and in view | — |
| `6-new-project-first-prompt.png` | A brand-new project started from the dashboard, mid-turn: its first prompt at the top, the work below | prompt 24px from the top for the whole turn |
| `7-reopened-lands-at-latest.png` | The project reloaded: it opens at its newest event, with no end space | `scrollTop` = furthest scroll, end space 0 |
