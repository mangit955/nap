# Pressing Enter on the dashboard: before and after the send glide

Recorded with `bun run verify-nap:up --production` (a `next build` and `next start` of the real web app,
with the real API, worker and Postgres, and a fake model and sandbox). Chrome was headless at 1440×900
unless noted. "Before" is `main` at 82dfce2d. "After" is the branch at 1467348d, where the right panel
starts closed and the starting view keeps the project's layout.

Frames come from Chrome's own screencast (`Page.startScreencast`), stamped with Chrome's paint time and
labelled with their offset from the Enter keypress. The positions in the tables were read on every
frame by a probe in the same page, after paint (a task posted from `requestAnimationFrame`, so that the
glide's `ResizeObserver` has already run). It recorded:

- the composer's box and transform;
- whether any ancestor that clips the composer cuts it off;
- whether any scrolling ancestor of the composer overflows sideways;
- whether the workspace's panes overflow sideways;
- whether the page has a scrollbar.

| File | What it shows |
|---|---|
| `send-realtime.gif`, `send-realtime.mp4` | Before (left) and after (right), side by side, aligned on the keypress, in real time |
| `send-slow-5x.gif`, `send-slow-5x.mp4` | The same two takes played five times slower. The frames are the real ones, each held five times longer |
| `before-frames.jpg`, `after-frames.jpg` | Eight frames of each, from just before Enter to about +320 ms |
| `after-slow-start-frames.jpg`, `after-slow-start-slow-5x.mp4` | The server's answer held for 1.5 s, as a real sandbox's start keeps "Starting your project…" up: the glide lands on the starting view, and the project's view takes over in the same place |
| `after-panel-open-frames.jpg`, `after-panel-open-slow-5x.mp4` | A right panel opened during an earlier start, so this start's view has it open: the project's view opens with it open too |
| `after-saved-width-frames.jpg`, `after-saved-width-slow-5x.mp4` | 1920×1080 with the right panel open and saved at 760 px. The saved width is restored after the glide has started, which narrows the column |
| `reduced-motion-frames.jpg` | `prefers-reduced-motion: reduce` emulated: the cut |
| `refused-start-frames.jpg`, `refused-start-slow-5x.mp4` | The start refused 150 ms after Enter (an injected 400), landing mid-glide: back on the dashboard with the error |
| `phone-frames.jpg` | 390×844 |

| Take | Dashboard composer (left, top, right, bottom) | First workspace frame, as drawn | Hand-over to the project's view | Last frame still moving |
|---|---|---|---|---|
| Before | 380, 384, 1116, 530 | +36 ms, already in its slot (272, 830, 880, 884) | n/a | n/a |
| After, panel closed (the default) | 380, 384, 1116, 530 | +36 ms: 396, 476, 1100, 530 (translate 0, −354) | +83 ms, centre 748 on both sides | +334 ms |
| After, start answered at 1.5 s | 380, 384, 1116, 530 | +25 ms: 396, 476, 1100, 530 (translate 0, −354) | +1563 ms, settled at 396–1100 on both sides | +308 ms |
| After, panel opened while starting | 380, 384, 1116, 530 | +34 ms: 288, 476, 896, 530 (translate 16, −354) | +87 ms, centre 585 to 582 | +314 ms |
| After, 1920 px, 760 px saved panel | 720, 474, 1456, 620 | +35 ms: 452, 566, 1156, 620 (translate 98, −444) | +70 ms | +336 ms |
| After, phone | 20, 366, 370, 508 | +21 ms: 16, 454, 374, 508 (translate 0, −320) | +40 ms | +304 ms |
| After, reduced motion | 380, 384, 1116, 530 | +20 ms, in its slot (396, 830, 1100, 884), transform `none` | +40 ms, same centre | none |

In every "after" take, every frame from Enter to +500 ms (to +2000 ms in the slow start) had zero
clipped composers, zero sideways overflow on the composer's ancestors, zero sideways overflow on the
panes and no page scrollbar, with one exception described below.

Reading the table:

- **Panel closed.** The right panel now starts closed, so the conversation column is wide and the
  composer goes straight down: its centre stays at 748, under where it was typed, through the hand-over
  and into its slot. A starting view whose saved panel is closed is the same take: it is the default.
- **Start answered at 1.5 s.** The glide finishes on the starting view at 396–1100, and when the
  project arrives its composer is drawn at the same left and right edges. The starting view keeps the
  same lane clear of the thread details card as the project's view does. Before that, the starting
  view's composer sat at 496–1200 and moved 100 px left when the project took over (seen in the
  reduced-motion take of an earlier build, 848 to 748 across).
- **Panel opened while starting.** The project's view opens with the panel the starting view had, so
  the column keeps its width at the hand-over and the composer moves 3 px across, not the 161 px of
  the earlier build, whose new project opened its panel by default. One of four recordings of this
  take had a single probe sample, at +48 ms, with the composer 191 px left and clipped. No screencast
  frame shows that position (the frames at +36, +53 and +70 ms are where they should be), and three
  more recordings had no such sample.
- **1920 px, 760 px saved panel.** The saved width is restored after the glide has started and narrows
  the column; the glide is clamped again and its horizontal offset only shrinks, frame to frame.
- **Phone.** The composer only moves down.

Three more checks, on the same build:

- **A refused start.** After a refusal landing mid-glide (+150 ms), the dashboard is back by +177 ms
  with the composer's transform `none`. The only animations still running are SVG icons (the
  sidebar's spinners for projects at work).
- **The right panel's default and its hand-over** are covered by tests in
  `apps/web/src/workspace/project-switch.test.tsx` and `workbench.test.tsx`, each seen to fail when
  the behaviour it guards is removed.
- **Back and Forward, and a second tab,** were recorded on e3d25ccb and moved nothing. This change does
  not touch how a glide is claimed, only where the panel starts.
