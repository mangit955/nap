# Integrate idle-only computer input

The hook and input overlay are independent of `ComputerPane`, AppShell, the event stream, and noVNC. The parent owns their placement, the toolbar button, and the accent rim. `LiveDesktopFrame` stays permanently view-only. Human input goes through the owner API.

Call `useComputerControl` once above the visible live frame. Pass these inputs:

| Input | Type | Parent value |
| --- | --- | --- |
| `sessionId` | `string \| null` | Current owner session |
| `active` | `boolean` | Visible live source with a fresh event stream |
| `connected` | `boolean` | Current `LiveDesktopFrame` connection is connected |
| `busy` | `boolean` | Inflight turn or unfinished test capture |
| `sourceKey` | optional `string` | Nonsecret stream generation or sandbox identity |
| `fetch` | optional `FetchJson` | Stable injected transport for tests. Production defaults to `credentialedFetch` |

Set `active=false` on history, hide, or a stale event stream. Set `connected=false` immediately when the current stream disconnects. Key or remount the hook owner by `sandboxId` when the VM changes. Pass the same nonsecret `sourceKey` to the hook and overlay if a source can change without that remount. Never use a grant, password, or private transport URL as a key.

The returned values are:

| Output | Meaning |
| --- | --- |
| `available` | Local prerequisites and the latest authoritative GET permit requesting control |
| `disabledReason` | Visible explanation for unavailable control, or `null` |
| `driving` | An unexpired grant exists for this generation |
| `status` | Copy for a status region, including acquisition, driving, release, expiry, or failure |
| `error` | Sanitized error copy, or `null`. No raw server or exception text |
| `takeControl(): Promise<boolean>` | Explicit POST of JSON `{}`. Resolves true only for a current valid grant |
| `release(): void` | Drops the grant, aborts pending requests, and settles queued input false |
| `sendActions(actions: readonly HumanComputerAction[]): Promise<boolean>` | Sends one validated atomic batch. True means every action was confirmed applied |

Use `available` to disable **Take control of Nap’s computer**. Render `disabledReason` visibly near the button, with `aria-describedby` pointing to that text. A disabled button's title alone is insufficient. While `driving` is true, offer **Release control**. Wire release directly to `release`, and call `takeControl` from the takeover button. Duplicate requests during acquisition are ignored.

Place `ComputerInputSurface` above the stream, inside the existing **Remote computer** application container. It adds no application role. Pass `driving`, `available`, `sourceKey`, `sendActions`, `takeControl`, and `release` from the same hook owner.

The overlay is absolutely positioned and fills its nearest positioned ancestor. Align that ancestor with the framebuffer viewport, excluding the floating toolbar and any frame border. With the current `LiveDesktopFrame` one-pixel border, an absolutely positioned wrapper inset by one pixel aligns with its inner target. Keep that wrapper's pointer events disabled so the overlay's own rules control hit testing. The frame remains centered and letterboxed at 1024×768. Do not stretch or crop the desktop independently of the overlay.

The overlay supplies the exact hint **Click anywhere to drive the computer**. Its transparent textarea has accessible name **Type on the remote computer**. On acquisition it receives focus without scrolling. Enter or Space can acquire control when it has focus. During control, normal Escape is remote input. Shift+Escape releases control, after which Tab follows ordinary browser focus navigation. The parent keeps its toolbar outside the overlay's bounds or above its stacking layer.

Apply the existing `useRimMask` and `RimGlow` to the parent's frame ref, using the existing `ai-lights` recipe and palette. Show those layers only while `driving`. Keep the glow outside the clipped framebuffer viewport and leave the toolbar interactive. The standalone fixture uses a simple accent border and shadow to show this state. Its captures do not verify the parent's final mask, pulse, or toolbar layout.

GET `/sessions/:sessionId/computer/control` runs immediately and then every five seconds after the preceding response. It checks availability across all project sessions. POST `/control` and every POST `/input` enforce availability independently. Polling is presentation feedback, not a replacement for the backend project guard. The hook expires the grant at the returned `expiresAt` and requires an explicit retake. It does not renew grants automatically.

Input batches contain at most 16 schema-validated atomic actions. Mouse moves coalesce only when adjacent in the unsent queue. Clicks, keys, and text retain their order. A left drag is one action containing both endpoints. No remote key or mouse button remains held across requests. Single clicks wait 400 ms to distinguish double clicks, and a subsequent key or text input flushes a pending click first. A browser click with detail 2 replaces a still-pending first click with one remote double click. After the first click was flushed or consumed by acquisition, detail 2 sends only one remaining remote click.

Explicit paste uses the paste event's plain text. It creates at most 16 `type` actions of at most 2,000 UTF-16 code units each, preserving Unicode pairs. A paste that cannot fit is rejected entirely with visible feedback before any chunk is queued. The component synchronously submits every chunk as a separate request to the hook's existing queue, before another keyboard or mouse event can interleave. Each request has the existing five-second API deadline. The hook awaits each acknowledgement and drops unsent chunks on failure, generation change, or expiry. Ctrl+V, Command+V, and Shift+Insert do not also send remote paste keys. Copy and cut cannot export a remote clipboard through the local textarea. The component never reads the browser clipboard API.

A false `sendActions` result can mean cancellation, a coalesced mouse move, invalid input, or an ambiguous failure. Never resend that batch automatically. A rejected, partial, stale, or unavailable input response ends control and discards unsent work. Aborting an inflight request cannot undo physical input already applied. The server guard remains responsible for excluding lease claims during physical dispatch. The client tests do not prove that database property.

The two `.test.tsx` suites cover the hook and overlay in the web Vitest project. The standalone browser fixture is under `apps/web/src/testing/take-control-review`, outside Next routing. Reproduction and the remaining cloud/reference gaps are in [the evidence record](README.md). Parent wiring, its `RimGlow`, and its real stream must be verified after integration before #150 closes.
