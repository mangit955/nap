# A session finishing out of sight: the toast and the unread dot

Recorded with `bun run verify-nap:up` (`next dev` of the real web app, with the real API, worker and
Postgres, and a scripted model and fake sandbox). Chrome was headless at 1440×813. The stills and recordings are from the branch's first commit, c43083f9, on top of `main` at
30f69061. Review then narrowed *when* the toast fires without changing how it looks, and the
flow was driven again on 0dccf9bd: toast, dot, Open, and the dot clearing. The approved design is
`.scratch/premium-ui-trial/phase-4-t3/` (`trial14`), stills `14-background-completion.png` and
`14b-after-open.png`.

Every take follows the user's path: **New session**, type a prompt, Enter, then click **Seeded notes
app** in the sidebar while the new session is still *Working*. Frames come from Chrome's own
screencast (`Page.startScreencast`).

| File | What it shows |
|---|---|
| `before-other-working.png` | Viewing *Seeded notes app* while *Fixture title 001* works in the background |
| `toast-and-dot.png` | It finished: the toast at the bottom right, and its row's blue dot beside "now" |
| `after-open.png` | After **Open**: *Fixture title 002* is open, its dot is gone, the toast is gone. *001*, never opened, keeps its dot |
| `dashboard-unread-dots.png` | The same dot on the dashboard's list (*Seeded notes app* after **Mark unread**) |
| `switch-toast-open.mp4` | The whole take in real time: send, switch away, the toast arrives, **Open** |
| `toast-in-out-slow-5x.mp4` | The toast's entrance and exit at a fifth of the speed |
| `motion-frames.jpg` | The bottom right every 100 ms: it rises from below the edge (0.7–1.1 s) and drops away fading after **Open** (1.4–1.6 s) |
| `reduced-motion-frames.jpg` | `prefers-reduced-motion: reduce` emulated over CDP. The take delivered 21 screencast frames, and these are the last four, labelled with Chrome's paint time: no toast (6.63 s, 7.27 s), the toast fully in place (7.28 s), gone (15.28 s, its 8 s timeout). The screencast sends a frame whenever the page repaints and delivered none in between, so nothing slid or faded |

The reduced-motion take had to be recorded with no driver command running while the toast was up:
each command re-attaches Playwright, which resets the emulated media. A first attempt with commands
in flight showed the slide, because the emulation had been dropped, not because of the CSS.
