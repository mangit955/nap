# Isolated guard mutations

All approved mutations were effective, caused the expected guard failures, and were restored. Current primary snapshot `3eb603f1ca099b27db9508699ae0767f2d0b1ea1`, tree `e34dd62a070da565c8aa05b6006fa001a35edd56`, remained unchanged. HEAD/base `13f7fa7f478982ed9316f2348f2ee5f61214bd00`. No normal primary code repair or full-suite mutation run occurred.

## Native component guards

Owned pristine archive `<run>/mutation-source` came from `git archive` of current 3eb, not a Git worktree. Tar `<run>/logs/mutation-source.tar`,53,841,920 bytes, SHA-256 `51c6a17a264c679263455bd005af6df4a42aa050b705208b58c67c335fd707aa`. All tracked archive blobs matched before mutation and again after all cases. Only root/web node_modules symlink to existing dependencies;504 shared-package source blobs were verified equal. No dependency download or other checkout mutation.

Preparation/mutations ran through `run_check.py --timeout 300 -- python3 <run>/logs/final3eb-native-mutations.py`, then a bounded180-second continuation for only the two remaining cases. Each child command was `bun run test:fast --project web <file> --testNamePattern <pattern>`, cwd the archive, timeout 90. Complete argv, exact text replacements, original/mutant blob hashes, timestamps and exits are in `logs/final3eb-native-mutations.json`; literal output is `logs/final3eb-mutation-<case>.log`.

Expected exit 1 and relevant assertion failures were observed:

- `dashboard-native-default`: default persistSidebar true→false. Native existing-width/collapse control failed, 1 selected failure.
- `workbench-native-default`: modal true→false. Native focus acquisition/containment/restoration and Tab controls failed, 2 failures.
- `sidebar-scroll-native-default`: persistScroll true→false. Native store/restore control received 0 instead of seeded 640,1 failure.
- `modified-selection-exclusion`: removed `&& !modified` from local selection eligibility. All Meta/Control/Shift/Alt cases failed because local selection was called once; their document listener also observed defaultPrevented true instead of false,4 failures.
- `rename-deferral`: changed the immediate-commit branch condition to true. Delay guard saw selection called once before commitment; double-click guard saw two calls, 2 failures.
- `already-closed-focus-guard`: removed only closeNavigation's already-closed return. Desktop row-focus control failed, 1 failure.

All files were restored in per-case finally blocks. Aggregate `archiveSourceChanges=[]`, `primaryUnchanged=true`, six cases have expectedFailureObserved/restored true. The original 11 and round 2 six old-production reds were not repeated.

Two orchestration issues are retained honestly. Initial Python3.9 extraction rejected an unsupported filter argument before any test/mutation; its empty owned directory alone was removed, and standard tar extraction was used. The initial collector rejected the modifier case because expected document-listener assertion errors were also printed as unhandled errors. Inspection confirmed all four named tests failed for the exact callback/cancellation violation; those valid results were retained rather than rerun. `final3eb-native-mutations-setup-error.json` and `final3eb-native-mutations-partial.json` preserve both histories; `prepare-native-mutation-resume.py` documents the evidence-based classification and remaining-only continuation.

## Actual browser guards

Command `run_check.py --timeout 90 -- node <run>/logs/final3eb-browser-mutations.mjs`, exit 0, Chrome 153.0.8010.54, one isolated390×844 page/context. The actual new headline and typography guard fragments were extracted verbatim from current check-landing.js; full fragment source/hashes and exact failures are preserved in `logs/final3eb-browser-mutations.json`. These were targeted guard executions, not another full-page suite.

- Headline: natural real wheel scrolling established entered=true. The first nonempty line's original inline style attribute was saved, opacity 0 important applied and allowed to settle. Actual observation showed entered=true, first-line opacity 0, second-line opacity 1 and both original texts. The real rendered-headline wait failed within its finite bound. Exact original style attribute was restored and both opacities returned to1.
- Body: a temporary owned stylesheet made the nonempty `.nf-heading-aside p`14px. The actual typography guard rejected `readable text size: .nf-heading-aside p`; removing the sheet restored 16px.
- Label: a separate temporary owned stylesheet made the nonempty hero eyebrow10px. The actual typography guard rejected that selector; removing the sheet restored 12px.

No entered flag or text was set, no production style/source changed, and no synthetic visual mutation entered AFTER capture. Two initial setup attempts observed opacity before an effective hidden state was established and therefore did not execute/count the guard. Their JSON files remain `final3eb-browser-mutations-ineffective-style.json` and `final3eb-browser-mutations-unsettled-inline.json`. The final counted run waited for actual computed 0 before testing and actual restored 1 afterward. No ineffective mutation was called a successful guard failure.

## Cleanup

Every mutation source/style was restored; archive and primary fingerprints confirmed. All browser contexts/processes and targeted test jobs ended, shared port 3000/resource.lock untouched. `logs/final3eb-cleanup.json` confirms recorded PIDs absent. Archive/raw logs are preserved for rerun/review, without active servers or processes. This report establishes guard sensitivity and restoration, not merge readiness.
