# Input repair evidence

These repairs address the two accepted P2 findings from the input review of original commit `51b9c582a3c280774ea3cac7da00eeb938b2c0bb`, against supplied parent `c31107e`. Production changes are confined to `computer-input-surface.tsx`. The hook implementation, API deadline and schema, parent panes, AppShell, and CSS are unchanged. The parent's separate Escape and Tab propagation repair is outside this commit.

The pending click ref now determines whether detail 2 can replace a first click with a remote double click. If the first click has already been sent or consumed by acquisition, only one remaining click is sent. Paste submits every bounded chunk synchronously through the hook's existing queue as a separate request. Later events queue after all paste chunks. There is no extra queue, replay, or renewal.

Before editing production code, the original 43 focused tests passed. Four new click tests failed on the extra double-click action. Four new paste tests failed because the first request contained 16 actions instead of one. After repair, all 51 focused tests passed and all 51 were listed by collection. The final focused run followed mutation restoration.

The maximum-paste test composes the actual component and hook with `createApp`, its ownership checks, signed grants, input schema, five-second deadline, and `performDesktopAction`. A deterministic X11 host calculates elapsed time from the actual `xdotool --delay` argv and stdin length. Sixteen distinct 2,000-unit chunks each receive HTTP 200 and their own 5,000 ms deadline. The modeled typing delay is 2,000 ms per chunk, totaling 32,000 ms. Withheld acknowledgements prove only one request starts at a time, and later Enter and right-click input follow the complete paste. Additional tests revoke unsent chunks after a real API timeout response, source replacement, or grant expiry, without replay.

This is an argv-derived timing model, not measured X11 or E2B throughput. Real network overhead, owner cookies, physical desktop effects, and parent integration remain outside this fixture. Typed values and grants are never displayed or logged by the fixture or browser checks.

Ten behavior mutations were caught and restored. The three additions restore the erroneous double-click action, restore a single paste batch, and await each chunk in the component so later events interleave. Every mutation must fail with an assertion. Run mutations only in an idle checkout.

```sh
bunx vitest run --project web --maxWorkers=2 apps/web/src/computer/computer-input-surface.test.tsx apps/web/src/computer/use-computer-control.test.tsx
node docs/assets/computer-use/take-control-review/check-mutations.mjs
bunx vitest run --project web --maxWorkers=2 apps/web/src/computer/computer-input-surface.test.tsx apps/web/src/computer/use-computer-control.test.tsx
bunx vitest list --project web --maxWorkers=2 apps/web/src/computer/computer-input-surface.test.tsx apps/web/src/computer/use-computer-control.test.tsx
```

The focused browser check uses current source through a Vite development server, without a production or fixture build. It imports the existing fixture and shipped component and hook. Start the server from the repository root:

```sh
node docs/assets/computer-use/take-control-review/serve-repairs.mjs
```

Start a dedicated Chrome in another terminal:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9356 --user-data-dir=/tmp/nap-input-repair-chrome --no-first-run --no-default-browser-check about:blank
```

Run the focused check:

```sh
node docs/assets/computer-use/take-control-review/check-repairs.mjs
```

All five checks passed in Chrome 153 on 2026-10-24, with no runtime exceptions. Trusted CDP clicks cover grant arrival between clicks, timer-flushed first clicks, key-flushed first clicks, and ordinary pending double clicks. CDP supplies click counts explicitly and does not measure the host OS double-click interval. Synthetic ClipboardEvent paste covers 32,000 units, 16 type actions, an empty local textarea afterward, and continued control. The local fixture accepts actions immediately; the separate API timing test establishes request budgets and acknowledgement order. Existing PNGs and their hashes are unchanged.

T3 preview was attempted first and failed twice with `Preview automation snapshot timed out after 15000ms.` The dedicated Chrome/CDP workflow is the documented fallback. No logged-in browser, passive reference, paid call, cloud sandbox, build, push, PR, or delegated agent was used.

The existing web glob collects the expanded `.test.tsx` suite. The web tsconfig includes it, and Biome covers the changed source and review scripts. Lefthook and CI already run the relevant gates. No configuration, manifest, or frozen v1 plan change is required.

The full `bun run test --maxWorkers=2` run completed with 411 files passing and one failing, 5,414 tests passing and two failing, and no type errors. Both failures were in the unchanged `packages/db/src/postgres-sandbox-capacity.db.test.ts`: “admits exactly the ceiling when a hundred arrive at once” exceeded its 5,000 ms timeout, and “holds the per-user cap when one user's admissions arrive at once” received zero admissions instead of two. This repair is therefore handed back as WIP despite its passing focused proof. No database code or test timeout was changed.

`bun run typecheck`, `bun run lint`, and `git diff --check` passed. Lint retains the existing CSS specificity warning and test-file informational notice. The real pre-commit hook result is recorded with the handoff commit.

An isolated rerun of the unchanged failing database file passed all 20 tests in 5.88 seconds. That does not turn the failed full run green. The full-run failures remain a handoff limit.
