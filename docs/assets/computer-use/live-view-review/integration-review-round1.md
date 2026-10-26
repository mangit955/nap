# Parent computer UI review: uncommitted tree on HEAD c31107e

Read-only. No source edits, no paid calls, no builds, no subagents. Focused web tests only:
`bunx vitest run --project web apps/web/src/computer apps/web/src/components/app-shell.test.tsx apps/web/src/chat/chat-transcript.test.tsx`
→ 10 files / 167 tests passed. One throwaway probe (`/tmp/nap-review-probe/probe.ts`) calls the pure
`inFlightTurn` and imports nothing else.

Scope: app-shell.tsx; computer-pane, use-desktop-stream, live-desktop-frame (the whole lifecycle,
checked against the installed noVNC 1.5.0 `lib/rfb.js` state machine), app-test-cards/state,
recording-viewer wiring, navigation, recording-navigation; globals.css; and the keyboard
propagation change in computer-input-surface.tsx. Input-hook internals are left out, as asked.

## Findings

### P2: The Computer pane's busy flag ignores the server's idle observation, so Take control can stay disabled for good
`apps/web/src/components/app-shell.tsx:234-235`

`computerBusy = inFlightTurn(log.events) !== undefined || …` calls `inFlightTurn` without
`idleThroughSeq`. The chat already treats a raw log fold as not authoritative.
`use-turn-submission.ts:372-375` passes the server's `/activity` observation (`idleThroughSeq`),
because some logs have a start with no terminal: legacy repair turns whose original request was
never recorded (see the comment at `use-turn-submission.ts:20-22`). AppShell cannot see that
observation because it lives inside `LiveChatPane`.

The client gate short-circuits. `useComputerControl` returns early when `busy` is true
(`use-computer-control.ts:68`), so the server's `/computer/control` is never polled and cannot
override it.

Reproduction (confirmed with the pure function):
- Log: `seq 1 user.message turn=legacy-repair` (no terminal), then `seq 2-3` for another turn that
  started and completed.
- `inFlightTurn(events)` returns `{ turnId: "legacy-repair", … }`, which is what AppShell uses.
- `inFlightTurn(events, 3)` returns `undefined`, which is what the chat shows after the server
  reports idle.
- The result: the chat composer is idle and the server would grant control, but the Computer pane
  shows "A turn is running in this project. Wait for it to finish." Take control and click-to-drive
  stay disabled for the life of that session's log.

Fix direction: give AppShell the same activity observation (move the activity read above
`LiveChatPane`, or have the chat pane report it upward) and pass `idleThroughSeq` here. The test
half (`tests.some(status === "running")`) has the same failure for a `test.started` that has no
`test.completed`. The janitor now writes one, but logs written before that change may not have it.

### P3: Shift+Escape (the advertised release shortcut) hides the whole right panel when the owner is not driving
`apps/web/src/computer/computer-input-surface.tsx:291-297`, which bubbles to
`apps/web/src/workspace/workbench.tsx:127-133`

The new `if (driving) event.stopPropagation()` covers the driving case only. When not driving,
the surface's textarea is focusable whenever `available`. Shift+Escape then runs
`preventDefault(); cancel(); release(); return;` without stopping propagation. The Workbench's
`keyboard` handler matches `event.key === "Escape"`, ignores `shiftKey` and `defaultPrevented`, and
calls `controller.hide()`. That closes the panel, which sets `active` false and tears down the live
stream.

Most likely trigger: the grant expires or fails (`driving` turns false asynchronously) while the
user presses Shift+Escape to release. Their release keypress then closes the panel. It also
happens on any Shift+Escape while focused and available.

The new test (`computer-input-surface.test.tsx:6`) renders only `driving`, so it does not cover
this. Fix: stop propagation in the Shift+Escape branch whatever `driving` is (and arguably for
Enter/Space when they take control).

### P3: The input overlay is inset 1px from the noVNC canvas box, so mapped coordinates drift near the edges
`apps/web/src/app/globals.css:2709-2713` (`.computer-input-overlay { inset: 1px }`) against
`live-desktop-frame.module.css` (`.viewport, .target { inset: 0 }`)

Both are absolutely positioned inside the same `.frame` padding box. That box already sits inside
`.frame`'s own 1px border, so the extra 1px inset is not needed to clear a border. noVNC autoscales
the 1024×768 canvas to fill and centres the target box (`_screen` is flex, canvas `margin: auto`).
`point()` (`computer-input-surface.tsx:119-124`) letterboxes against the overlay's rect instead,
which is 2px smaller on each axis and offset by 1px.

Measured from the formulas: on a 600px-wide frame the error is 0 at the centre and about ±1.7
desktop px at the edges. Narrower panes are worse. The outermost 1px ring of the visible desktop
cannot be clicked at all; the viewport is `inert`, so those clicks reach nothing.

Fix: `inset: 0`. If a visual gap is wanted, map against the noVNC target's rect instead.

## LiveDesktopFrame lifecycle: no defects found
Checked against noVNC 1.5's `_updateConnectionState` and `_fail`:
- The constructor connects synchronously. A thrown constructor (for example a bad URL) is caught;
  `release()` with a null `rfb` just removes the target.
- `securityfailure` is dispatched before `_fail`. `finish` then `release` then `disconnect()` moves
  to `disconnecting`. `_fail`'s own `disconnecting` is ignored as same-state, and `disconnected`
  fires with the listeners already removed. `disconnect()` on an already-disconnected RFB only logs,
  and logging is `none`.
- Each generation gets its own target, so a late `_disconnect` → `removeChild(_screen)` cannot touch
  its successor. Strict Mode's double effect is safe for the same reason.
- `await createRfb` and the dynamic import both re-check `active`.
- Quality before connect: the noVNC setters store the value and send encodings only when
  connected. `configureQuality` and the `[quality]` effect cover both orders.
- `viewOnly`, `focusOnClick=false`, `inert` and `aria-hidden` on the viewport: noVNC gets no input
  path, and its clipboard is suppressed.
- Retry with `onRetry` (from the pane) goes through `stream.retry`. The status flips to `loading`,
  which unmounts the frame and mounts a new one on fresh credentials. `connected` is keyed on the
  credentials object's identity, so a stale "connected" cannot carry over.

Also checked with nothing to report:
- **Pop-out:** `?panel=computer` runs after `usePanelLayout`'s restore effect for the same key, and
  the functional updates apply in order.
- **Credentials:** the desktop password is static for the desktop's lifetime (`desktop-driver.ts`
  `credentials` reads a file), so a second window does not retire the first one's credentials.
- **Recording:** recording URL → `?download=1` → `Content-Disposition: attachment`; CORS is
  credentialed; the viewer unmounts when the selected test stops being "available".
- **Viewer keyboard:** the viewer's Escape lives outside the Workbench React subtree.
- **Composer listener:** the composer's capture listener on `document` ignores textarea targets.

## Limits
- Nothing was run in a browser, and no real noVNC/E2B connection was made. The 1px drift is
  computed from CSS and noVNC's layout code, not measured on screen.
- The Devin viewer and takeover comparison, and real-cloud behaviour, are pending as stated. Their
  absence is not counted as a defect here.
- The input-hook internals were not reviewed (reviewed separately), for example `release()` being
  client-only.
- Copy nit, not a defect: a clean server disconnect after a successful connection shows "Failed to
  connect to Nap's computer".
