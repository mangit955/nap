# A session card's branch, beside its pull request, diff and model

Captured with verify-nap: the real web app, API and Postgres, on the fake model and sandbox, in its
headless Chrome at 1280×720. The sidebar width was set the way its resize handle stores it
(`nap.sidebar.width`), and the page was reloaded.

The fakes never open a pull request, so no session of theirs has a branch. To draw one, the
fixture's throwaway Postgres was given a GitHub installation, a repository for each of the two
sessions, and one repository job each (`nap/7c1d2e3f-…` with PR #287, and
`feat/pricing-table-with-annual-toggle` with PR #312). Each session's model was set to
`anthropic/claude-sonnet-5.5` and its latest diff to +87 −5, the lengths seen in production.
Everything else came through the UI. The rows and the component drawing them are the real ones.

- `before-256.png`, `before-208.png`: `main` at `5398934f`. The branch's text paints over `#287`
  and `+87`, and at 208px the model runs off the card.
- `after-256.png`, `after-208.png`, `after-416.png`: this change. No branch is drawn on a card, so
  the pull request, diff and model have the line to themselves, and nothing overlaps at any width.
  The branch is in the row's tooltip and under Copy → Branch.
- `option-*-320.png`, `option-*-416.png`: the three ways of drawing a `nap/<uuid>` branch that were
  put to the owner, all with the overflow fix: A is head and tail, B is `nap/` and the first 8
  characters, and C leaves it out. C was chosen. Every branch Nap makes is `nap/<uuid>`, so
  leaving it out means no card draws a branch. The `feat/…` row in these shots exists only in
  the fixture's database.

The guard is the last case in `apps/web/src/dashboard/sidebar-drag.integration.test.ts`. It
measures each chip's painted text every 4px from 208 to 420px, and checks that only the pull
request, diff and model are drawn.
