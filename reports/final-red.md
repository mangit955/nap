# Final allowance tests-first evidence (R7)

The approved run produced exactly five intended behavioral assertion failures and 19 passes across two files. Exit code 1 is the requested regression evidence. No import, collection, fixture, unhandled or type errors occurred. No retry or downstream check ran.

## Identity and command

- Cwd: `<repo>`
- Branch: `feat/dark-workspace-media`
- HEAD: `852bf4c637200362c4767cf163bdb3894ed6e20b`
- Base: `9ca9cd5074edabde49ba1014849aff32057a90f6`
- Tests-only snapshot: `be209fcf6878dc53adaef352933593459496c291`
- Tree: `152855d3af8becc9084909134ef6d1638204a7c0`
- Exactly two staged test files differ from HEAD: `apps/web/src/components/live-chat-pane.test.tsx` and `apps/web/src/dashboard/dashboard.test.tsx`. Worktree and index match the snapshot before and after; no untracked files. Canonical staged entries hash is unchanged. Production source remains the published HEAD for this run.
- Environment: macOS 27.0.1 arm64, Python 3.9.6, Bun 1.4.2, Node 24.7.0, Vitest 4.1.10.

```sh
python3 <home>/.claude/skills/gods-hand/scripts/run_check.py --timeout 120 -- bun run test --project web apps/web/src/components/live-chat-pane.test.tsx apps/web/src/dashboard/dashboard.test.tsx
```

Bun expanded the existing package test script, retaining its unit/types/web/db project flags and appending the approved web/file filters. Actual collection was two web files and 24 tests. Vitest reported 4.20 seconds; the supervised command completed in 4.582 seconds. No resource deadline expired.

## Expected versus observed

| Case | Observed failure | Evidence |
|---|---|---|
| First dashboard prompt after rate-limit refusal | Message remained empty instead of `Use the pasted layout and this flow` | `live-chat-pane.test.tsx:132`; raw log lines 17–24 |
| First dashboard prompt after network refusal | Same missing original Message value | Same grouped assertion, raw log lines 18–24 |
| Edit/ref removal after refused first dashboard prompt | Initial recovery text absent; subsequent edit/removal assertions not yet reached | `live-chat-pane.test.tsx:181`; raw log lines 180–185 |
| Portal keyboard traversal | Expected Put away focused after Rename + Tab; Close sessions drawer trigger had focus | `dashboard.test.tsx:59`; raw log lines 342–357 |
| Portal Escape before drawer Escape | Menu dismissed, but Close sessions missing and Open sessions present: drawer also closed | `dashboard.test.tsx:73`; raw log lines 395–411 |

The final role query failure occurs at the intended post-Escape drawer assertion, after setup and menu interaction succeeded. It is behavioral red evidence, not a fixture failure. The three recovery tests timed out at their bounded `waitFor` value assertions, not at the resource-runner deadline. The other 19 preservation tests passed, including existing composer recovery/replay and dialog coverage. These results establish the pre-repair failures; later assertions in the failing tests remain unproven until the repaired candidate runs.

## Cleanup and artifacts

The runner returned after its owned process-group cleanup, its PID is absent, and the stable shared resource lock is available. No browser, fixture server, build, media encoder or downstream gate started. No source/index writes were performed by the verifier. The recorded post-run identity predates any subsequently authorized implementation.

- Raw output: `logs/final-red.log`
- Exact argv, environment, timestamps, exit, and before/after identities: `logs/final-red.metadata.json`
- Captured cleanup: `logs/final-red-cleanup.json`

Resource ownership is released to the parent. Final candidate checks require a new pinned snapshot and approval.
