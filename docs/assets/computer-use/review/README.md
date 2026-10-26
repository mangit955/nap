# Computer-use reference and mockup

This is design evidence for [UI reference #139](https://github.com/mangit955/nap/issues/139), part of [the computer-use map](https://github.com/mangit955/nap/issues/137). The candidate is the standalone [HTML mockup](../../../computer-use-mockup.html), not the Nap application.

## Reference provenance

`devin-computer-live.png` was captured passively with REA 6.7.0 on 2026-10-24 at 01:55:12 UTC. Chrome 153.0.8010.54, viewport 2400×1584, target `141EBB4D1B97897DFFA1182D4EC3EC56`, session `03c36065206644bcbfbef5317049a161?tab=browser`. SHA-256 `0f703f7dd7919ac862eff29cbf5e701c95c62af554f013304616d60612b985a8`. The page was already open. No click, input, or navigation was sent to the Devin browser.

Compare this with `nap-computer-live.png`. Both show an idle Computer tab at the live end of its timeline. The Nap image uses a synthetic sign-in page drawn with HTML and Nap's tokens. The desktop uses a 1024×768 logical canvas that scales to its frame. No Devin bundled code, icons, or application assets are included in the mockup.

Only the live reference state was available. The other PNGs show proposed Nap states derived from the approved brief. They are **not** paired evidence of an observed Devin connection failure, takeover, test card, or recording viewer. Those references still need passive captures before their respective product UI tickets close. The saved inspections and bundle analysis remain outside the repository under `/tmp/nap-devin-rea/`.

## Candidate evidence

Desktop captures use 1440×1100, scale 1. Phone captures use 390×844 without touch or OS keyboard emulation. Chrome 153.0.8010.54 on macOS, Node 26.12.0. Candidate screenshots were regenerated after fixing an inline screenshot thumbnail and scaling the desktop as a single canvas.

- `nap-computer-live.png`, `nap-computer-history.png`, and `nap-computer-driving.png` show the timeline and takeover states.
- `nap-computer-waiting.png`, `nap-computer-starting.png`, `nap-computer-connecting.png`, `nap-computer-failed.png`, and `nap-computer-empty.png` show the five connection/history states.
- `nap-recording-viewer.png` and `nap-dom-replay-concept.png` show the chaptered overlay and later DOM replay controls.
- `nap-computer-phone.png` and `nap-recording-phone.png` show the narrow layout with reduced motion and transparency.

Playback uses a fixture clock. Download returns a text file explicitly marked as mockup data. Stream quality, viewport, theme, rotate, and text-size controls show the intended control vocabulary without a remote renderer. No remote input, video capture, model call, sandbox, persistence, or repair runs. The product must replace the mockup's pulse, rim, and elapsed display with the existing Nap hooks and components. No audio control is present.

## Reproduce the browser check

Use a dedicated Chrome profile. Keep the Devin browser at port 9223 passive.

```sh
python3 -m http.server 4319 --bind 127.0.0.1
```

In another terminal, start headless Chrome:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9337 --user-data-dir=/tmp/nap-computer-mock-profile --no-first-run --no-default-browser-check about:blank
```

Then run:

```sh
node docs/assets/computer-use/review/check.mjs
```

The check takes optional CDP endpoint and page URL arguments. It opens and closes its own tab. It writes 12 candidate PNGs beside itself and asserts history navigation, busy takeover denial, connection states, explicit repair, chapter navigation, Space and Shift+Arrow keys, DOM console visibility, focus return, reduced preferences, and narrow overflow. Most buttons are exercised with DOM clicks. Keyboard shortcuts use CDP input. This does not establish trusted pointer input, mobile touch, OS keyboards, noVNC, or product accessibility.

The guard was observed failing after changing the session timeline maximum from 3 to 2. It failed with `'2' !== '3'`; the mutation was reverted and the check passed. The check refuses port 9223 before opening a tab. The collaborative preview failed twice at snapshot with `Preview automation snapshot timed out after 15000ms.`, so these captures use the repo's documented local Chrome fallback. T3 HTML previews also passed at 1100px and 390px with no console messages.

## Gate coverage

The HTML and review script are documentation artifacts. Biome includes both. They are outside TypeScript and Vitest by design, so the explicit browser check above is their execution gate. They add no shipped module, exported API, dependency, event, or Next route. Existing hooks and CI configuration need no changes. The six-tool invariant remains true at this commit; the draft ADR and implementation follow in separate tickets. `docs/PLAN.md` and `PROGRESS.md` remain the frozen v1 record.
