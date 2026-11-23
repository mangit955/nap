# Pressing Enter on the dashboard: before and after the send glide

Recorded with `bun run verify-nap:up --production` (a `next build` and `next start` of the real web app,
with the real API, worker and Postgres, and a fake model and sandbox). Chrome was headless at 1440×900
unless noted. "Before" is `main` at 82dfce2d. "After" is the branch at 25bb3de5.

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
| `before-frames.jpg`, `after-frames.jpg` | Eight frames of each, from just before Enter to +320 ms |
| `after-panel-closed-frames.jpg`, `after-panel-closed-slow-5x.mp4` | A starting workspace whose saved right panel is closed, while the new project opens it |
| `after-saved-width-frames.jpg`, `after-saved-width-slow-5x.mp4` | 1920×1080 with the right panel saved at 760 px. The saved width is restored after the glide has started, which narrows the column |
| `reduced-motion-frames.jpg` | `prefers-reduced-motion: reduce` emulated: the cut |
| `refused-start-frames.jpg`, `refused-start-slow-5x.mp4` | The start refused 150 ms after Enter (an injected 400), landing mid-glide: back on the dashboard with the error |
| `phone-frames.jpg` | 390×844 |

| Take | Dashboard composer (left, top, right, bottom) | First workspace frame, as drawn | Last frame still moving |
|---|---|---|---|
| Before | 380, 384, 1116, 530 | +36 ms, already in its slot (272, 830, 880, 884) | n/a |
| After | 380, 384, 1116, 530 | +23 ms: 288, 476, 896, 530 (translate 16, −354) | +305 ms |
| After, saved panel closed | 380, 384, 1116, 530 | +25 ms: 396, 476, 1100, 530 (translate −100, −354) | +305 ms |
| After, 1920 px, 760 px saved panel | 720, 474, 1456, 620 | +18 ms: 452, 581, 1156, 635 (translate 98, −429) | +302 ms |
| After, phone | 20, 366, 370, 508 | +19 ms: 16, 454, 374, 508 (translate 0, −320) | +302 ms |
| After, reduced motion | 380, 384, 1116, 530 | +32 ms, in its slot (272, 830, 880, 884), transform `none` | none |

In every "after" take, every frame from Enter to +500 ms had zero clipped composers, zero sideways
overflow on the composer's ancestors, zero sideways overflow on the panes and no page scrollbar.

Reading the table:

- **After.** The composer starts with the bottom edge the dashboard's composer had. With the panel open,
  its sideways move is clamped to the 16 px the conversation column leaves before the right panel, so it
  is never drawn under the panel and cut off.
- **Saved panel closed.** The column is wide, so the composer starts centred under where it was typed
  (748 across in both). At the hand-over (+42 ms) the project's view opens its panel, the column's edge
  moves in under the composer, and the composer moves with it to stay inside (centre 587): the column
  changing width, which moves the composer without the glide too.
- **1920 px, 760 px saved panel.** The first frame painted was already about 3% into the glide (−429 of
  −444 down). Its right edge sits on the narrowed column's edge (1156): the glide was clamped again when
  the saved width landed.

Three more checks, on the same run:

- **A refused start.** After a refusal landing mid-glide (+150 ms), and after one landing before the
  workspace drew (+0 ms), the dashboard has no animation on the composer, the panel or the conversation.
  The composer's transform is `none`. The elements with an inline `transform` or `overflow` are exactly
  those of a freshly loaded dashboard: `html` and `body` with `overflow: hidden`, which is the
  dashboard's own scroll lock, and one visually hidden element (1px, clipped).
- **Back and Forward.** After a send had landed, going Back to the dashboard and Forward into the
  project drew 54 frames, none moving.
- **A second tab.** Opening the same project in a second tab drew 362 frames, none moving.
