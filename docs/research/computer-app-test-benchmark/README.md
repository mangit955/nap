# App-test benchmark integration

The planted-bug apparatus and guarded production runner are integrated locally in `5708444` and `206c266`. The [independent review](review.md) found no actionable defects in those two units and passed 71 focused free tests. The first Claude review attempt was rate-limited before producing a verdict; the replacement review used the parent's provider. No failed review is counted as a pass.

The free CLI runs four production test turns with a scripted model and fake cloud ports. It reports `modelCapability: null`. Its 0/2 bugs caught and 2/2 correct specimens accepted show that scoring distinguishes the expected outcomes from a model that always says passed. They establish no real model capability. The planted specimen source, canonical paths and deterministic git checkpoints are independently checked.

The native Chrome integration suite uses actual fixture JavaScript and real page reload. All four cases passed without E2B or model calls. Fixing each planted bug deliberately made its buggy-case assertion fail, then the original fixture bytes were restored and all four tests passed again. Requests are intercepted and fulfilled from local files; there is no server or proxy in this check. This proves the specimen outcomes, not physical X11 control or autonomous bug detection.

The worker's [apparatus proof](worker-apparatus.md) and [production-composition proof](worker-composition.md) describe fifteen observed guard failures. Their raw mutation logs are preserved in the mutations directory. The production-selection tests inject fake ports and execute authentic local git commands; they do not create remote VMs. Mocked construction checks the real adapter and provider options without calling their services.

The final integration gate passes 5,571 tests across 425 files, typecheck and lint. The adjacent logs record those results, native Chrome checks and collection. Trailing whitespace is stripped from preserved text logs. Architecture rules continue to forbid runtime importing bench. New suites are inside the existing unit, web and integration globs; the native browser suite skips without NAP_CHROME_PATH and must be run explicitly. No manifest, hook, timeout or CI exclusion changed. The frozen generation suites remain unchanged.

Real balanced model trials and cloud cleanup remain unverified. The user's free-only instruction defers those calls, so issue 155 stays open. Read docs/NAPBENCH.md for the command and scoring contract.
