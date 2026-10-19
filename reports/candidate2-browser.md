# Final candidate browser evidence

All planned browser behaviors have evidence on candidate `777f193e09c28bec5616c4b5480dfebc219ab0c7`, tree `1b4bb068dfa87fbf05909201286cf06340a661dc`, production BUILD_ID `3IZId8qOVPj4mkSoaJqP5`. The first full command exited1 only at its final New session selector: the UI legitimately has a visible-text primary button and an icon-only add button with the same accessible name. Its completed checkpoints remain valid. A separately approved drawer-only continuation chose the role/name plus exact visible text and passed. The full media/control scenario was not rerun.

Both used installed Chrome153.0.8010.54 / Playwright Core1.57.0, one isolated browser/context at a time, the actual compiled Next production components served on ephemeral loopback, and fake auth/API/project/model/socket/preview routes. No browser request reached an external service; no unexpected blocked request or pageerror occurred. Source/index stayed exact. The model response retained the existing wire contract, with known vision IDs; no capability field was added.

| Command | Timeout | Exit | Elapsed | Evidence |
|---|---|---|---|---|
| Full scenario, label browser-candidate2 | 180s | 1, final selector ambiguity | 7.477s | logs/browser-candidate2.log, .metadata.json, .result.json |
| Drawer-only continuation, label browser-candidate2-drawer | 60s | 0 | 1.691s | logs/browser-candidate2-drawer.log, .metadata.json, .result.json |

Exact structured argv and minimal environment policy are recorded in candidate-queue.json and command metadata. The executed full script is archived as browser-check-full-candidate2.mjs; the continuation is browser-check-drawer-candidate2.mjs. Metadata includes their SHA-256s. Both runs require the successful candidate2-build.metadata.json tree and exact BUILD_ID.

## Preview and mobile state

At390,900,1280, Page to show, Reload the preview, and Open the preview in a new tab each had one accessible visible control fully inside the viewport. Reload caused exactly one additional iframe request; changing route produced `/pricing`; Open launched that route in a temporary popup, then closed it. This changes R2's measured absent controls at390/900 to present controls at every width. Screenshots: `screenshots/browser-candidate2-{390,900,1280}.png`.

At390, the real file input prepared the tiny image and video. A four-line draft, both attachments and the alternate model survived Code and Preview tab switches. Hidden chat was absent from accessible textbox queries. A fake503 restored text and attachments. A subsequent accepted-but-not-yet-started submission retained Stop and a disabled composer through both tab switches. After synthetic durable failure, the actual Try again button resubmitted the same model and exact attachment frame bytes; a completed retry cleared Stop.

## Native media and transport

The run generated one48×32 PNG (191bytes) and a one-second48×32 WebM with six video frames and a tiny audio tone (3051bytes). FFmpeg used one thread, a15-second deadline and fixed dimensions/duration; no capacity ramp, user recording, package installation or saturation occurred.

The actual browser prepared one JPEG frame for the image and exactly three JPEG frames for video. All four output JPEGs decoded to48×32. Chrome measured video duration1.008s; sampled timestamps were0.0504,0.504,0.9576 (5%,50%,95%). Video/frame wire keys contained no audio field. Frame character counts were1076 for the image and1756/1764/1752 for video. Captured serialized payloads for refused POST, accepted resend and transcript retry had identical frame bytes/hashes and model. Full hashes are in the result JSON; reports do not embed base64.

## Composer and drawer

With multiline text, both attachments and a visible failed-send error, the final transcript element remained above the composer at each width after scrolling to the bottom:

| Width | Final transcript bottom | Dock top | Document width |
|---|---|---|---|
| 390 | 503.4375px | 526.5px | 390px |
| 900 | 498.9375px | 522.5px | 900px |
| 1280 | 498.9375px | 522.5px | 1280px |

Computed composer border/shadow/outline and native textarea caret styling were equal before/after focus. Native tag was TEXTAREA, caret color visible, caret-animation auto. This checks the native control/style path, not physical blink timing or OS keyboard behavior. Screenshots: `screenshots/browser-candidate2-media-error-{390,900,1280}.png`; the verifier inspected the390 images, and the parent inspected phone/desktop media-error images.

The drawer-only continuation at390 verified keyboard opening moves focus inside, Tab remains within the drawer/control, Escape closes and restores trigger focus, and the primary New session closes the drawer, empties the prompt and focuses it. Screenshot after those assertions: `screenshots/browser-candidate2-drawer-dashboard-390.png`, showing branding and the cleared composer. Its role/name-plus-exact-visible-text locator avoids arbitrary positional selection. No source change was needed.

## Cleanup and limits

Both runs record contextClosed, browserClosed, serverClosed and nextClosed true. Temporary preview popups closed. The bounded encoder completed. All runner PIDs are gone, shared resource lock available, and candidate source/index exact in logs/candidate2-final-cleanup.json. Only the pre-existing Docker review DB remains.

This evidence covers real component rendering, browser media preparation and the client transport payload with fake service boundaries. It does not exercise paid model responses, real auth/sandbox provisioning, production database persistence, mixed-version rollout, high-resolution decoder memory, other browsers/codecs, touch hardware or physical caret blink. The deterministic suite and existing persistence tests cover their own boundaries; do not infer untested end-to-end production behavior from this browser run.
