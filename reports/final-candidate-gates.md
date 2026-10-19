# Final corrected candidate gate results

All approved gates passed for snapshot `5e115c34f609cc5574c63873e4f8974c1ec9f921`, tree `f3e781fb55d43dc8fd58bf09f7a6ba2416c3e4ff`. The narrow production browser passed against its fresh build. These results are check evidence; the independent reviewer and parent own the merge assessment.

HEAD remains `852bf4c637200362c4767cf163bdb3894ed6e20b`, base `9ca9cd5074edabde49ba1014849aff32057a90f6`. Cwd `<repo>`, branch `feat/dark-workspace-media`. Exactly eight owned staged files, no unstaged/untracked files, and canonical staged modes/blobs match before and after every command. Exact argv and source identities are in `final-corrected-queue.json` and each `logs/final-corrected-*.metadata.json`.

| Check | Timeout | Actual result | Runner seconds |
|---|---:|---|---:|
| Corrected Dashboard tests | 120s | Exit 0; 1 file / 11 tests | 0.849 |
| `bun run typecheck` | 300s | Exit 0; 14 package tasks + root, 13 package cache hits; changed web executed | 0.626 |
| `bun run test` | 600s | Exit 0; 315 files / 4318 tests, no type errors | 31.259 |
| `bun run lint` | 180s | Exit 0; 817 files, no diagnostics/fixes | 0.363 |
| `bun run build --force` | 600s | Exit 0; cache bypass, Next compiled in 605 ms | 3.582 |
| Narrow production browser | 180s | Exit 0; all 3 checkpoints passed | 5.173 |

Fresh BUILD_ID: `6l0ofJHG6QIniogm3bGRE`, bound to the final tree in `logs/final-corrected-build.metadata.json`. The Next build skips type validation by repository configuration; the separate successful required typecheck above supplies it. Every command used the shared `run_check.py` once with a finite timeout, serially. No timeout or unexpected result occurred on this corrected candidate.

Environment: macOS 27.0.1 arm64, Node 24.7.0, Bun 1.4.2, Python 3.9.6, Vitest 4.1.10, Turbo 2.10.8, TypeScript 7.0.2, Next 16.3.0, installed Chrome 153.0.8010.54 and Playwright-core 1.57.0. Default deterministic tests used the established free ephemeral Docker DB fixture; no paid integration project/model/API/sandbox was invoked.

## Preserved red and earlier candidate evidence

R7 on tests-only `be209fcf6878dc53adaef352933593459496c291` produced exactly five intended failures and 19 passes: three missing first-prompt recovery assertions plus portal Tab/Escape behavior. See `reports/final-red.md`.

The first repair candidate `eabd50082405a015c922aab8f35da2df781f6a4f` passed the affected 10 files/144 tests and full 315 files/4318 tests, then failed the required web typecheck at `dashboard.test.tsx:68`: unsupported Testing Library role-option `exact`. The queue stopped before lint/build/browser. Its actual result is preserved in `reports/final-candidate-eabd5008-gates.md` and `logs/final-candidate-typecheck.log`/metadata.

The only corrected-snapshot delta removes that redundant `exact:true` option from the Delete role query; the installed string name matcher remains exact. All production code and other tests are byte-identical to eabd5008. The corrected Dashboard suite ran first, followed by typecheck and the complete suite on this exact final tree. The earlier affected coverage remains valid for unchanged files; no duplicate affected-wide command was needed.

The approved single successful-admission mutation ran on eabd5008 after its full suite: remove only `if (accepted) setFirstPrompt(undefined)` from LiveChatPane, run `does not recover an accepted first prompt when a later transcript retry is refused`. It failed exactly at Message expecting empty but receiving the original first prompt (test line253); one failure/12 skipped, no setup errors. Child exit 1, supervisor exit 0. Exact source bytes/mode and canonical staged contents were restored before typecheck. That production file and targeted test are unchanged on corrected 5e115c34, so the mutation was not repeated. Evidence: `logs/final-candidate-admission-mutation-child.log`, `.result.json`, supervisor `.log` and `.metadata.json`. Preimage SHA256 `8bb7c031fc13abe17578ae4f07f287abcaeed643f22995aa46b93c4467c97e9c`, mode 0644.

## Cleanup and scope

All six corrected runner PIDs are absent; no final-browser script process remains; shared lock is available and its stable lock file retained. Browser context, Chrome, HTTP server and Next app all closed. Full-suite ephemeral DB fixtures exited; only unrelated pre-existing `nap-theme-review-db` remains. No source/index edits other than the earlier explicitly approved and exactly restored one-line mutation were performed by the verifier. Cleanup: `logs/final-corrected-cleanup.json`.

The browser report is `reports/final-candidate-browser.md`. Earlier native media preparation evidence remains tied to the previous candidate 777f193e/tree1b4bb068. The final delta changes optional recovered preview ownership/guards, not native image/video preparation functions; final focused/full tests cover the changed ownership path. No encoding, capacity search, old mutation matrix or old responsive control/dock matrix was repeated. No live provider, public preview/auth or cross-browser claim is made.
