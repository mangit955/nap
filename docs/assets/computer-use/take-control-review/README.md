# Take-control component evidence

This partial implementation of [#150](https://github.com/mangit955/nap/issues/150) adds the real `useComputerControl` hook and `ComputerInputSurface` component. [Integration instructions](INTEGRATION.md) describe the parent's button, live-frame overlay, disconnect boundaries, and `RimGlow` wiring. No ComputerPane, AppShell, API, database, shared wire schema, or global stylesheet changes are included.

Seven PNGs show live takeover availability, driving, a lease in another project session, history, disconnect, input failure, and a 390×844 layout. Desktop captures are 1440×1100, scale 1. Chrome 153.0.8010.54 on macOS, Node 26.12.0, captured 2026-10-24. The narrow capture enables reduced motion and transparency. It does not emulate a touch device or OS keyboard. `SHA256SUMS` records the committed PNG bytes.

The standalone fixture imports the shipped hook and input overlay. Its injected transport returns schema-shaped control grants and input results locally. It displays action kinds and coordinates, never typed text or grants. Its background is the existing synthetic Nap sign-in screenshot from [panel review](../panel-review/fixture-desktop.jpg). That file was produced from Nap's mockup HTML, not a third-party screen. The fixture's border and shadow represent the driving state. They do not establish the parent's final `RimGlow` layout.

The only existing passive reference is [Devin's idle live desktop](../review/devin-computer-live.png), with [capture provenance](../review/README.md). Compare it with `nap-take-control-live.png` for the desktop framing only. A matching passive take-control reference is missing. No Devin interaction or new Devin capture occurred for this work. There is no claim of a paired takeover match, and #150 stays open for that gap and parent integration.

The browser check drives its own tab on a dedicated local Chrome. Trusted CDP input verifies click acquisition without remote activation input, centered coordinates, double-click deduplication, right and middle clicks, whole drags, text, IME commit, chords, remote Escape, Shift+Escape release, and wheel isolation from local document scrolling. It also verifies revocation after an authoritative busy response, current-turn busy denial, history, disconnect, ambiguous input failure, and phone letterbox rejection. Runtime exceptions fail the check.

The focused Vitest suites use deterministic deferred HTTP responses for pending grants, pending status, and inflight input. They cover release, source changes, session changes, history, disconnect, busy transitions, expiry, malformed responses, forbidden actions, queue ordering, coalescing, no replay, paste limits, Unicode, IME, gestures, and unmount cleanup. The fake transport intentionally ignores abort so late responses still arrive. Those tests prove client retirement behavior. The database lease/input exclusion proof belongs to the existing backend tests at base `cdee93f` and is not established by this fixture.

T3 preview was attempted first. It failed twice at snapshot with `Preview automation snapshot timed out after 15000ms.` The captures therefore use the repo's documented dedicated Chrome/CDP fallback.

To reproduce from the repository root, build and serve only the local fixture:

```sh
bun build apps/web/src/testing/take-control-review/main.tsx --outdir /tmp/nap-control-review --target browser --define 'process.env.NEXT_PUBLIC_API_URL="http://localhost:3001"'
cp apps/web/src/testing/take-control-review/index.html /tmp/nap-control-review/index.html
cp docs/assets/computer-use/panel-review/fixture-desktop.jpg /tmp/nap-control-review/fixture-desktop.jpg
python3 -m http.server 4326 --bind 127.0.0.1 --directory /tmp/nap-control-review
```

In another terminal, start a dedicated browser:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9346 --user-data-dir=/tmp/nap-take-control-profile --no-first-run --no-default-browser-check about:blank
```

Run the browser check:

```sh
node docs/assets/computer-use/take-control-review/check.mjs
```

Run the focused tests and mutation checks sequentially:

```sh
bunx vitest run --project web --maxWorkers=2 apps/web/src/computer/use-computer-control.test.tsx apps/web/src/computer/computer-input-surface.test.tsx
node docs/assets/computer-use/take-control-review/check-mutations.mjs
bunx vitest run --project web --maxWorkers=2 apps/web/src/computer/use-computer-control.test.tsx apps/web/src/computer/computer-input-surface.test.tsx
bunx vitest list --project web --maxWorkers=2 apps/web/src/computer/use-computer-control.test.tsx apps/web/src/computer/computer-input-surface.test.tsx
```

The mutation script temporarily changes one owned source file at a time and restores it in `finally`. It checks generation retirement, serialized input, exact applied count, polling cleanup, letterbox mapping, IME deduplication, and delayed-click cleanup. Every mutation must fail on a behavioral assertion. Run it in an idle checkout, never alongside another test or edit of these files.

At handoff, `bun run test --maxWorkers=2` passed 411 files and 5,385 tests with no type errors. The new suites contribute 43 tests, all listed by `vitest list`. `bun run typecheck` and `bun run lint` passed. Lint reports one pre-existing warning in `globals.css` and one informational notice in `git-comparison-limits.test.ts`. All seven behavior mutations were caught and restored, and the final full suite ran after restoration.

All source and fixture TypeScript is included by `apps/web/tsconfig.json`. Both `.test.tsx` suites are collected by Vitest's `web` project. Biome covers the source, module CSS, fixture, and review scripts. The existing lefthook staged-file lint, workspace typecheck, and changed unit/web tests cover these additions. CI runs lint, typecheck, and the full free suite. No new glob, architecture dependency, hook, or workflow is needed. `docs/PLAN.md` and `PROGRESS.md` remain frozen v1 records.

The parent must still integrate the hook and overlay into its live frame and controls, then verify real owner cookies, view-only VNC, protected HTTP input, source replacement, busy/test-capture transitions, and the final accent rim. No cloud sandbox, paid model, E2B template build, or network input to a remote computer ran here.
