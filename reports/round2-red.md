# Round2 tests-first evidence

R6 produced the one requested behavior red: the hidden-chat failure summary was absent when chat reopened. The corrected refused-POST recovery test passed, including restoration of text and attachment plus resend of the same exact frame bytes. No production implementation changed for this check.

Snapshot `a98e009e6e13481866a4126f8348a758c6ed2764`, tree `944621a13ac5077270b30e5269833661640cd246`; HEAD `5a150ab3ba42241f732d47973d64f57a5702053f`; base `9ca9cd5074edabde49ba1014849aff32057a90f6`. The snapshot differs from candidate `26e108e3b5461d9f8e58ae916c64fe98c354b428` only in app-shell.test.tsx and live-chat-pane.test.tsx (+45/-2 total). The tracked worktree/index matched the new snapshot before and after, with no untracked files.

Cwd `<repo>`. Exact command:

```text
python3 <home>/.claude/skills/gods-hand/scripts/run_check.py --timeout 120 -- ./node_modules/.bin/vitest run --project web apps/web/src/components/app-shell.test.tsx apps/web/src/components/live-chat-pane.test.tsx
```

Observed exit1 after 2.562 supervised seconds. Two files collected: one failed, one passed; 1 test failed and 20 passed. The failure is **summarizes a failure received while chat was hidden when it is shown again**, at `apps/web/src/components/app-shell.test.tsx:220`: `findByRole("region", { name: "While you were away" })` exhausted its local polling deadline. The expected region was missing after Show chat. This is an actual behavior assertion failure, not a resource-runner deadline or import/fixture error. The subsequent failure-copy assertion was not reached.

The LiveChatPane file's eight tests all passed, so the corrected waitFor now observed both restored controls before resending. This green alone does not prove the recovery assertion detects broken restoration; the prepared supplemental SW fault removes only the text-restoration setText call for that separate check after the next candidate is approved.

Full output: `../logs/round2-red-web.log`; exact command/toolchain/source identities/timestamps: `../logs/round2-red-web.metadata.json`; cleanup: `../logs/round2-red-cleanup.json`. The supervised runner exited and performed owned process-group cleanup, its PID is gone, and the shared resource lock is available with its file preserved. No browser, server, encoder or Docker database was started for this web project. The parent was notified immediately when the runner released; later fixer changes must not be attributed to this check.

Only R6 ran. Supplemental supervisors and their placeholder queue are prepared, unexecuted; no mutations, broad checks or candidate browser/build ran.
