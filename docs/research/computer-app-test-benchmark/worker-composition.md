# Ticket 155 real-composition implementation proof

Follow-up commit: `303864217c3cd359b661a4bd277064f88f71796f`.
Preserved parent unit: `d598eb9195c2c29a52d920ede8c63f8c7f54b5a5`.

The real CLI implementation is present. No production sandbox or model call was run. A template-build or VM-only approval does not authorize its model calls.

Free reproduction commands:

```sh
bun run apps/napbench/scripts/napbench-app-test.ts --out=/tmp/nap155-free.json
bun run test --maxWorkers=2
bun run typecheck
bun run lint
bunx vitest list --project unit --project web app-test
```

Final results are 419 passing files and 5,464 passing tests, no type errors, plus passing typecheck and lint. Lint retains the pre-existing CSS warning and sandbox-test informational diagnostic. Normal commit hooks passed, with 56 tests in 7 changed suites. Full outputs, collection and compiler file lists, and hook output are alongside this file.

The real-selection tests always inject factories and fake ports. They use actual local git repositories with extra template files to verify authentic baseline-to-specimen commits and diffs. Production construction tests mock every external client. Neither path reaches E2B or OpenRouter. Injected reports label their execution and keep modelCapability null.

Nine mutations were killed by assertion failures: image-model validation, credential validation, authentic parent, canonical paths, committed source, separate production test limits, owned VM destruction, screenshot archive handling, and provider output limit. The mutation logs retain the actual failed test names and outputs. Red logs also preserve the initial missing implementation, output-destination guard, and committed-blob regression.

Coverage includes both new unit suites and all four new script files. Existing architecture rules inspect their imports; no manifest, hook, CI, runtime, API, shared, or web-source change was required. Generation suites and the prior negative gates remain intact.

The task remains open for parent review and separately approved real validation. No new delegated task or subagent was created for this follow-up; it continues the existing task thread.
