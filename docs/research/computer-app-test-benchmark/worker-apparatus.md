# Ticket 155 verification

The local WIP contains only packages/bench, apps/napbench, and docs/NAPBENCH.md.

Reproduce the free apparatus from the worktree root:

```sh
bun run apps/napbench/scripts/napbench-app-test.ts --out=/tmp/nap-app-test.json
bun run test --maxWorkers=2
bun run typecheck
bun run lint
bunx vitest list --project unit --project web app-test
```

The default apparatus must catch 0 of 2 planted bugs, accept 2 of 2 correct specimens, and report modelCapability: null. This is deliberately scripted, with synthetic desktop observations. The independent DOM suite executes the real seeded handlers. Real composition and model evaluation are pending; --real refuses before infrastructure composition.

All six deliberate mutations were killed by assertion failures: flow matching, required screenshot, untested outcome exclusion, failed-tool exclusion, notes storage key, and cart arithmetic. Logs beginning nap155-mutation preserve the actual failures. The two DOM logs predate the rename from app-test-fixture.test.tsx to app-test-flows.test.tsx. The rename prevents TypeScript from skipping a same-stem TSX file.

nap155-routing-red.log records the initial git-environment regression. precommit-routing-failure.log records a later direct git status call in the test that still inherited hook routing. The test now uses the same isolated fixture git helper. Normal git commit hooks remain enabled.

The typecheck coverage list explicitly includes all nine new TypeScript and TSX files, including scripts and the DOM suite. The unit and web Vitest collection lists include all five new suites. Existing architecture tests inspect package and script imports; no manifest, architecture table, hook, or CI modification was needed. No generation-suite task or scoring implementation changed.

No paid service, real sandbox, template build, real model, OpenRouter, browser account, push, or PR was used. Final command logs and commit metadata are stored beside this file.
