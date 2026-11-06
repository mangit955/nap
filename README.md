# Steering — PR evidence

Screenshots for the steering PR (issue #192).

- `before-e1b53de3-*`: `origin/main` at `e1b53de3`. A turn is running, the composer is disabled and reads "Working…", and nothing can be sent until the turn ends.
- `after-b35dbbab-*`: `feat/steering` at `b35dbbab`. The composer stays open while a turn runs and reads "Steer the agent — it reads this at its next step…". Steers show inline as read, waiting, queued as the next message, or not sent with a Send again button.

How they were made: a temporary, uncommitted Next page in a scratch worktree at each SHA fed fixture `StoredEvent`s to the real `ChatPane`. `next dev`, headless Chrome on macOS, dark scheme, 1280×800 and 420×860 at 2x. No model, sandbox or API ran. `facts-*.json` records what the DOM showed in each capture: placeholder, whether the textarea was disabled, the buttons, the steer groups, and zero console errors.
