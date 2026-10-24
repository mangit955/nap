# App-test benchmark review, round 1

## Result

No actionable correctness or lifecycle defect found in the reviewed changes within the free-check scope. This is a review result, not a whole-feature completion or paid-validation claim.

Reviewed read-only in `/Users/manasraghuwanshi/.t3/worktrees/nap/t3-024ab7b9`:

- `d598eb9195c2c29a52d920ede8c63f8c7f54b5a5`
- `303864217c3cd359b661a4bd277064f88f71796f`
- Comparison base: `c31107e`, the parent of the first commit.

HEAD was the requested second commit before and after review. The source worktree remained clean. There were no prior findings or responses to reconcile.

## Findings

None confirmed. Accordingly, there is no severity, defect reproduction, or repair recommendation to assign.

## What I checked

I read `CLAUDE.md`, the relevant workspace, contracts, model/provider, sandbox/storage and testing GOTCHAS, `docs/NAPBENCH.md`, ADR-0007, and both worker proof READMEs. I inspected the added implementation and tests, then traced its calls into the production runtime, assertion ledger, computer tool, context engine, budget handling, sandbox manager, desktop adapter, template setup and OpenRouter/provider composition. Worker test and mutation claims were supporting context, not independent proof of execution here.

- The two fixture pairs differ at the intended storage-key or arithmetic expression. DOM tests execute the fixture JavaScript itself. The generation suite and its existing score implementation are unchanged by these commits.
- The free CLI uses the scripted provider and sandbox. Its synthetic captures are explicitly documented, and both scripted and injected execution keep `modelCapability` null.
- Real argument parsing requires the model and all four limits, rejects unknown/duplicate flags and unsupported image models, validates positive safe integers and token-limit relationships, and checks the context minimum, required credentials and report destination before factory construction.
- The real path reads the remote baseline, commits only the canonical specimen paths, checks the actual parent and diff, and compares both working files and committed blobs with the fixture. The same checks run after the test. It preflights the served heading, desktop DOM and screenshot before constructing the model provider.
- Neutral objectives and opaque IDs reach the runtime. Variant and expected-verdict labels remain in benchmark metadata. The runtime constructs the diff-grounded prompt and receives one `kind: "test"` request. No runtime-to-bench dependency was introduced.
- Evaluation filters by session and test-turn ID, requires the intended job/checkpoint and test lifecycle, and grades the designated chapter/assertion against the harness label. It checks final assertion counts, excludes untested results, and withholds scores for failed runtime/tool evidence, missing screenshots or source changes. A correct specimen with an additional failed assertion earns no acceptance credit.
- Aggregate bug and correct denominators include measured runs only. Unmeasured runs are counted separately, and any such run prevents a production `modelCapability` value.
- The real path checks announced screenshot keys against stored objects, archives the captured bytes under opaque session paths, withholds scores on archive failures, and attempts destruction of its owned VM in `finally`. Returned and thrown destruction failures are recorded and invalidate the score. Injected failure tests cover preparation, provider/runtime, post-test source, archive and destruction failures.

## Independent free verification

From the reviewed worktree:

```sh
./node_modules/.bin/vitest run --project unit --project web app-test --maxWorkers=2
```

Passed: **13 files, 71 tests**. This focused filename filter includes the seven new benchmark suites plus six existing app-test runtime/shared/web suites. The tests use scripted providers, fake/in-memory ports, mocked external construction and local git repositories. No integration project was selected.

```sh
bun run apps/napbench/scripts/napbench-app-test.ts --out=/tmp/nap155-review-free.json
```

Exit 0. The default report records scripted execution, `modelCapability: null`, 0/2 planted bugs caught, 2/2 correct specimens accepted, and zero unmeasured runs. Those are apparatus results, not model capability.

```sh
git diff --check d598eb9195c2c29a52d920ede8c63f8c7f54b5a5^ 303864217c3cd359b661a4bd277064f88f71796f
git status --short
git rev-parse HEAD
```

Diff check passed; status was empty; HEAD remained `303864217c3cd359b661a4bd277064f88f71796f`.

## Evidence limits

No E2B, model, OpenRouter, template, Devin, paid integration, `harness --real`, push, PR, subagent, or full-suite operation was performed. I did not independently rerun the worker's full typecheck, lint, full suite or mutation experiments.

Injected factories prove the composition and failure handling against the selected fake ports; mocked construction tests prove adapter wiring. They do not prove the published template's contents, actual Vite/desktop readiness on E2B, remote API behavior, real JPEG observations, provider acceptance of a particular budget/effort combination, real model judgement or remote destruction. The DOM tests simulate reload by remounting and do not establish real-browser persistence. These are explicit validation limits, not defects caused by the absence of paid testing.

The next paid-validation question, if separately authorized, is whether balanced real trials exercise and correctly judge both flows while preserving source and archived screenshots. This review makes no capability or merge-readiness claim beyond the inspected code and free evidence above.
