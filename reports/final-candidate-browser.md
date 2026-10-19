# Final corrected production browser evidence

All three approved narrow checkpoints passed in one supervised run (exit 0, 5.173 seconds, timeout 180). Candidate `5e115c34f609cc5574c63873e4f8974c1ec9f921`, tree `f3e781fb55d43dc8fd58bf09f7a6ba2416c3e4ff`, unchanged HEAD 852bf4c / base 9ca9. Fresh build `6l0ofJHG6QIniogm3bGRE` was checked against successful build metadata before opening the page; exact source/index identities were checked again after cleanup.

## Reproduction and boundary

Exact outer/inner argv and environment are in `logs/final-corrected-browser.metadata.json` and `final-corrected-queue.json`. The direct child was:

```sh
node <review-run>/final-browser-check.mjs --candidate 5e115c34f609cc5574c63873e4f8974c1ec9f921 --head 852bf4c637200362c4767cf163bdb3894ed6e20b --base 9ca9cd5074edabde49ba1014849aff32057a90f6 --build-metadata <review-run>/logs/final-corrected-build.metadata.json --include-portal true
```

It ran once under `run_check.py --timeout 180` from the repository, with credential variables not inherited. Script SHA256 `70b0098dac309c12e571ec3bcc7655bfbf8a1818f5c43c45c0a80043302e4504`. Repository documented installed Chrome workflow uses apps/napbench's existing Playwright-core 1.57.0; Chrome 153.0.8010.54. One local Next production server, one browser/context/page, viewport 390×900. Auth/project/model/file/turn/socket routes were fake and all other external requests blocked. Actual unexpected external requests 0; page errors 0. No real accounts, model, sandbox, project mutation or paid service was contacted.

The test seeded only `nap.first-prompt` with the actual serialized dashboard handoff shape, then navigated to the compiled project workspace. Thus the browser proves the consumer recovery path. The producer's project creation/storage contract is covered by the affected/full deterministic tests, not claimed as a repeated browser file-picker flow.

Prepared fixture: existing `apps/web/public/demo-poster.jpg`, 44,698 bytes, SHA256 `813af0f9eb9945d4612469c590ba781d34a5dcadf97b5ba9c93135532c92f359`. Its 59,600 base64 characters were reused once as an image and at 0.2/2/3.8seconds as three synthetic video frames for a 4-second reference. No encoding or video extraction occurred here. These frames prove transport/restoration/still rendering, not new native extraction. Unit regressions also use three distinct frame strings. Earlier real 48×32 PNG/WebM decoding evidence remains in `reports/candidate2-browser.md`, tied to its earlier tree; native preparation functions are unchanged by this repair.

## Actual checkpoints

1. First automatic POST received fake 429. Original text returned to editable Message, original alternate vision model remained selected, both references were removable. Recovered video rendered as a successfully loaded `IMG` whose src matched the first prepared JPEG; no `VIDEO` element existed. Storage handoff was consumed. Code-tab/chat rerender preserved recovery with exactly one POST, no automatic retry.
2. Text and model were changed then restored without sending. Explicit retry 2 exactly matched original message/model/all attachment fields and bytes, then received the second fixed 429. The user removed the image, edited text and chose the other vision model. Explicit retry 3 contained only the unchanged three-frame video and the chosen text/model and received fake 202. Durable user/start/completed events ended pending state. Completed page reload produced no extra POST and no resurrected composer media. Total exactly 3 POSTs; detailed payload hashes/counts/timestamps are in the JSON result.
3. Real SessionActions portal in the mobile dashboard received focus. Keyboard sequence was Rename→Put away→Delete→Put away→Rename→Delete→Rename via Tab/Shift-Tab including wrap. First Escape closed only the portal and focused its trigger; second Escape closed the drawer and focused Open sessions. Native Rename dialog then received Session name focus; Tab reached Cancel then Save. Native Escape closed the dialog, left drawer open and returned action-trigger focus; following Escape closed the drawer. No rename/delete/put-away request was sent.

## Visuals and cleanup

Screenshots were visually inspected: recovered references, refusal, text/model controls and Send remain visible at 390px; edited state shows only the video still; the portal shows Rename/Put away/Delete with focus on Rename.

- `screenshots/final-corrected-first-recovery-390.png`
- `screenshots/final-corrected-edited-recovery-390.png`
- `screenshots/final-corrected-session-portal-390.png`

Raw output `logs/final-corrected-browser.log`; structured result `logs/final-corrected-browser.result.json`; exact argv/source/build metadata `logs/final-corrected-browser.metadata.json`. Browser context, browser, server and Next app each closed successfully. Exact staged/worktree contents preserved; runner absent and shared lock available. See `logs/final-corrected-cleanup.json`.

Limits: one installed Chromium and mobile viewport, fake HTTP/WebSocket admission, bounded prepared-frame payload, no live provider or public deployment verification. No previous broad browser matrix, native encoder or capacity check was repeated. The earlier eabd5008 queue never reached browser because typecheck stopped it; that absence is retained in its gate report, while this report covers only corrected 5e115c34.
