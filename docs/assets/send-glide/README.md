# Pressing Enter on the dashboard: before and after the send glide

Recorded with `bun run verify-nap:up --production` (a `next build` and `next start` of the real web app,
with the real API, worker and Postgres, and a fake model and sandbox). Chrome was headless at 1440×900
unless noted. "Before" is `main` at 82dfce2d. "After" is the branch at 3e79fbe2.

Frames come from Chrome's own screencast (`Page.startScreencast`), stamped with Chrome's paint time and
labelled with their offset from the Enter keypress. The positions in the table were read on every
frame by a probe in the same page, after paint (a task posted from `requestAnimationFrame`). It recorded
the composer's box and transform, whether any ancestor that clips the composer cuts it off, whether
any scrolling ancestor of the composer overflows sideways, and whether the page has a scrollbar.

| File | What it shows |
|---|---|
| `send-realtime.gif`, `send-realtime.mp4` | Before (left) and after (right), side by side, aligned on the keypress, in real time |
| `send-slow-5x.gif`, `send-slow-5x.mp4` | The same two takes played five times slower. The frames are the real ones, each held five times longer |
| `before-frames.jpg`, `after-frames.jpg` | Eight frames of each, from just before Enter to +320 ms |
| `after-panel-closed-frames.jpg`, `after-panel-closed-slow-5x.mp4` | A starting workspace whose saved right panel is closed, while the new project opens it |
| `reduced-motion-frames.jpg` | `prefers-reduced-motion: reduce` emulated: the cut |
| `refused-start-frames.jpg`, `refused-start-slow-5x.mp4` | The start refused 150 ms after Enter (an injected 400), landing mid-glide: back on the dashboard with the error |
| `phone-frames.jpg` | 390×844 |

| Take | Dashboard composer (left, top, right, bottom) | First workspace frame | Last frame still moving | Clipped / sideways overflow / page scrollbar frames |
|---|---|---|---|---|
| Before | 380, 384, 1116, 530 | +36 ms, already in its slot (272, 830, 880, 884) | n/a | 0 / 0 / 0 |
| After | 380, 384, 1116, 530 | +21 ms, drawn at 240, 476, 896, 530 (translate 16, −354) | +321 ms | 0 / 0 / 0 |
| After, saved panel closed | 380, 384, 1116, 530 | +20 ms, drawn at 396, 476, 1100, 530 (translate −76, −354) | +304 ms | 0 / 0 / 0 |
| After, phone | 20, 366, 370, 508 | +35 ms, drawn at 16, 454, 374, 508 (translate 0, −320) | +318 ms | 0 / 0 / 0 |
| After, reduced motion | 380, 384, 1116, 530 | +22 ms, in its slot, transform `none` | none | 0 / 0 / 0 |

In every "after" take the composer's first frame keeps the bottom edge the dashboard's composer had.
With the panel open, the sideways move is clamped to the 16 px the conversation column leaves before
the right panel, so the composer is never drawn under the panel and cut off.

Three more checks, on the same run:

- **A refused start.** After a refusal landing mid-glide (+150 ms), and after one landing before the
  workspace drew (+0 ms), the dashboard has no animation on the composer, the panel or the prompt.
  The composer's transform is `none`. The elements with an inline `transform` or `overflow` are exactly
  those of a freshly loaded dashboard: `html` and `body` with `overflow: hidden`, which is the
  dashboard's own scroll lock, and one visually hidden element (1px, clipped).
- **Back and Forward.** After a send had landed, going Back to the dashboard and Forward into the
  project drew 55 frames, none moving.
- **A second tab.** Opening the same project in a second tab drew 341 frames, none moving.
