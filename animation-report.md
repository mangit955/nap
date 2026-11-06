# Steering state illustration

Artifact: `steering-states.gif`, 92,765 bytes, 960×600, looping 18-second slideshow.

This is an illustration made from actual saved ChatPane fixture screenshots. It is not a live interaction recording and does not measure pickup latency. No model, sandbox, API, new browser session or server ran to make the GIF. The original captures used real `ChatPane` components under `next dev`, headless Chrome on macOS, dark scheme, 1280×800 at 2x.

Each state lasts three seconds, in this order:

1. Base `e1b53de3`, running turn with disabled composer.
2. Feature `b35dbbab`, typed composer with a steer read and another waiting.
3. Feature `b35dbbab`, optimistic pending submission.
4. Feature `b35dbbab`, steer queued as the next message.
5. Feature `b35dbbab`, stopped steer with Send again.
6. Feature `b35dbbab`, unread steer after idle with Send again.

The later final repair preserves planning intent when retrying the last state; these captures show the earlier `b35dbbab` UI, not the final repair's retry payload. The regression tests cover that payload.

Reproduce from this directory with:

```sh
python3 /Users/manasraghuwanshi/.claude/skills/gods-hand/scripts/run_check.py --timeout 60 -- python3 make_animation.py
```

The runner returned exit 0. The initial drawtext-filter attempt failed because this ffmpeg build does not include that filter. The successful script uses no drawn captions; the PR must include this state legend and the illustration label beside its embed. First-frame visual inspection confirmed the base disabled composer capture.
