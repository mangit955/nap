# Round1 red regression evidence

R3 and R4 produced the expected behavioral failures against unchanged production code. No import, fixture-setup or unhandled runtime failures occurred. These are requested pre-repair results, not a failing baseline or a candidate verdict.

- Cwd: `<repo>`
- HEAD: `5a150ab3ba42241f732d47973d64f57a5702053f`
- Base: `9ca9cd5074edabde49ba1014849aff32057a90f6`
- Tests-only snapshot: `8c06167c8186c1584ef945ddb6809f62ac4a4286`
- Snapshot tree: `c521d86b887a54bb63bc0ee530a316aae220ed32`
- The tracked worktree and index matched that snapshot before and after each command. Branch HEAD/base did not change. The staged test changes belong to the fixer and remain intact.
- Environment: macOS 27.0.1 arm64, Node v24.7.0, Vitest 4.1.10, Python 3.9.6. Unit and jsdom web projects only. No integration credential loader, Docker, browser/native media decoder, real API, model or sandbox operation.

## R3

Exit 1. Two collected files, 4 failed and 100 passed tests, 104 total. Vitest duration 322 ms; supervised command duration 0.651 seconds.

```sh
python3 <home>/.claude/skills/gods-hand/scripts/run_check.py --timeout 120 -- ./node_modules/.bin/vitest run --project unit apps/api/src/turns/routes.test.ts packages/context/src/context-engine.test.ts
```

All four failures match GH-001's expected triggers:

| Assertion | Observed failure |
|---|---|
| API rejects media on Nemotron before admission, routes.test.ts:365 | Expected 400, received 202. |
| API rejects media on unknown custom allowlisted model, same assertion | Expected 400, received 202. |
| Nemotron context omits historical image blocks, context-engine.test.ts:854 | Expected empty image-block array; one JPEG image block remained. |
| Unknown custom model context omits historical image blocks, same assertion | Expected empty image-block array; one JPEG image block remained. |

Those tests stop at the first failed assertions. Later rate/queue, omission-text, durable-history and restored-vision assertions will need the repaired implementation to reach them. No import/collection error masked these triggers.

## R4

Exit 1. Six collected files, 5 failed and 1 passed; 8 failed and 98 passed tests, 106 total. Vitest duration 2.29 seconds; supervised command duration 2.557 seconds.

```sh
python3 <home>/.claude/skills/gods-hand/scripts/run_check.py --timeout 120 -- ./node_modules/.bin/vitest run --project web apps/web/src/chat/chat-input.test.tsx apps/web/src/chat/use-media-attachments.test.tsx apps/web/src/chat/use-turn-submission.test.tsx apps/web/src/components/app-shell.test.tsx apps/web/src/components/live-chat-pane.test.tsx apps/web/src/workspace/session-sidebar.test.tsx
```

| Finding and assertion | Observed failure |
|---|---|
| GH-002, app-shell.test.tsx:87 | Switching to mobile Code revoked the prepared image URL once; expected no revocation. The test stops here before later draft/model assertions. |
| GH-002, app-shell.test.tsx:117 | Stop was absent after the mobile tab switch and reopening chat. |
| GH-005/replay retry, live-chat-pane.test.tsx:141 | Submitted replayed video payload equality passed, then Stop was absent. This is optimistic state failure, not lost frame bytes. |
| GH-001, chat-input.test.tsx:49 | Add images or videos remained enabled for the selected text-only model. |
| GH-001, chat-input.test.tsx:65 | Switching a prepared reference to a text-only model produced no alert. Later send/Enter guard assertions were not reached. |
| GH-005, use-turn-submission.test.tsx:85 | Expected pending text `Use these references for the app.`, received undefined after the new 202 response matched old history. |
| GH-005 recorded-message gap, use-turn-submission.test.tsx:118 | After the new user.message arrived but before turn.started, expected running true, received false. |
| GH-004, session-sidebar.test.tsx:62 | Successful active deletion occurred, but the navigation mock was never called with `/dashboard`. |

The missing-element failures are expected UI observations in rendered components. They are not import or browser-fixture failures. `use-media-attachments.test.tsx` was the sole fully passing file, with its 17 preparation/limit/error/cleanup cases. Existing cases and the added failed-POST recovery, inactive/refused deletion, and hidden-chat seen-cursor assertions were among the passing tests. Green native-browser-boundary fakes do not substitute for the later tiny real-media check or required mutation evidence.

## Artifacts and cleanup

- `../logs/round1-red-unit.log`
- `../logs/round1-red-unit.metadata.json`
- `../logs/round1-red-web.log`
- `../logs/round1-red-web.metadata.json`
- `../logs/round1-red-cleanup.json`

Exact argv, cwd, snapshot/tree, environment description, exit code, timings and pre/post state are in the metadata. Only these two targeted commands ran. There was no separate collection pass, rerun, source/test repair, index mutation, commit, push or ledger write.

Both runners exited normally after process-group cleanup. No matching runner remains; the shared resource lock is available and its file remains. No browser, server or container was started by R3/R4. Queue entries are marked completed, expected red.

The full browser harness remains unexecuted. Its plan now uses the fixer's shared model-ID policy and unchanged `/models` wire contract, with no supportsImages response field or command argument.

## R5 direct-helper pre-implementation invocation

The later approved R5 invocation failed collection because the production helper module was intentionally absent. No test assertions executed. See `model-policy-red.md` for the separate state identity and missing-module result; R3/R4 remain the substantive behavioral red evidence.
