# Dragging between shelves, in a real browser

jsdom lays nothing out, so a drop cannot be tested there. These files come from
`apps/web/src/dashboard/sidebar-drag.integration.test.ts`. It drives the real sidebar (the real
`Sidebar`, the real `useSessionNavigation` and its optimistic queue, and the production stylesheet
compiled with Tailwind) against an in-memory navigation server. The pointer events are real
mouse events sent over the DevTools protocol.

Re-create them with:

```bash
NAP_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
NAP_SIDEBAR_PROOF_DIR=docs/assets/sidebar/drag \
node node_modules/vitest/vitest.mjs run --project integration \
  apps/web/src/dashboard/sidebar-drag.integration.test.ts
```

It costs nothing. It needs a local Chrome, `bun` to bundle the fixture and, for `drag.webm`,
`ffmpeg`. Captured in headless Chrome 156 at 288×720 CSS px, device scale 2, in dark mode.

| Case | Frames | What the test asserts |
|---|---|---|
| Pin | `01`–`03` | No boundaries before the drag, *Pinned* and *Active* while holding, none after the drop. The row shows the pin, is drawn first, and the server received `pin` and then the pinned order. |
| Settle | `04`–`05` | Dropping on the Settled header removes the row from the inbox, the shelf count goes from 2 to 3, and the server received `done: true`. |
| Un-settle | `06`–`07` | A settled row dropped into the inbox lands where it was let go. The server received `done: false` and then the inbox order. |
| Reorder | `08`–`09` | Dropped on Checkout flow, the row lands above it, and the order is sent. The click that ends the drag does not follow the row's link: the page stays on `/`. |

`drag.webm` records all four cases (6.5 s).

**Not shown here:** the touch sensor (a 250 ms press) and dragging with a scrolled list. There is
no keyboard drag, by design. The context menu's Pin, Settle, Un-settle, Move up and Move down
do what a drop does, and its tests are in `sidebar-menu.test.tsx`.
