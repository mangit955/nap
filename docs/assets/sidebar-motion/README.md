# Sidebar collapse and reopen motion

Captured with verify-nap (real web app, fake model and sandbox) in headless Chrome at 1200×780.

- `sidebar-*-before-after.mp4` / `.gif`: top is `main` (83b94b2a), bottom is this branch. Dashboard and inside a session.
- `base-widths.json`, `head-widths.json`: the sidebar's rendered width on each animation frame (requestAnimationFrame) for 300 ms after each press. `cssTransitionMs` is the duration Chrome reports for the running transition.
