# App test card review

These eight captures show the actual `LiveChatPane` and its real submission hook against the in-memory HTTP seam in `AppTestReview`. No API server, model or sandbox runs. The agent plan is scripted fixture text; its factual judgement is not measured.

The review covers approval, running, passed, failed, untested, interrupted, an explicit repair request, and a 390px layout. Approval posts only a job ID and model to `/tests`; the fixture returns the same durable request identity that its events use. Failed assertions make no request until Fix it is clicked. That click posts an ordinary turn to `/turns`. Result cards remain at their completion event in the transcript. The progress and elapsed state follow the existing single log and request-status reconciliation.

Watch recording is present and disabled because these tests have no recording. A test with no assertions says so rather than implying success. Another running turn disables approval and repair. A model without image support disables approval with a reason. The browser check also asserts 4.5:1 primary-button text contrast, the solid reduced-transparency fallback, no runtime exceptions, and no horizontal overflow at 390px.

Captured with Chrome 153.0.8010.54 at 1440×1100, and 390×1100 for the phone, on 2026-10-24. Next's development indicator is visible. No error overlay was hidden. The request path above the pane is review-fixture chrome, not part of the application.

## Reference gap

No passive Devin approval/result-card or recording-viewer capture is available. The observed [live Computer](../review/devin-computer-live.png) and [disconnected Computer with inline cards](../work-log-review/devin-reference.png) do not establish how these test cards look. The approved brief supplies the current layout, copy and state targets. Keep the UI ticket open until a matching passive reference can be reviewed. No Devin code, icons or assets are included.

## Reproduce

Use a dedicated Chrome on port 9337 and Next on 4320 as in the [Computer panel review](../panel-review/README.md). Temporarily create:

```tsx
// apps/web/src/app/app-test-review/page.tsx
import { AppTestReview } from "../../testing/app-test-review.tsx";
export default AppTestReview;
```

Then run:

```sh
node docs/assets/computer-use/test-cards-review/check.mjs
```

Remove the route afterward. The script refuses Devin's passive port 9223, owns its own tab and closes it. It waits for completed states to become idle before capturing them; an earlier capture showed the stale busy state before activity reconciliation caught up.

## Integration review

The new state fold and components have tests written before their exports. Hook tests exercise request identity, no optimistic user bubble, busy preparation and terminal recovery. A live-pane test proves Fix it reaches the normal submit path. Removing the live handlers made five tests fail, and the browser contrast check failed before the button foreground was corrected to Nap's existing solid-button white.

Every source and fixture is in the existing web TypeScript and Biome programs. New `.test.ts` and `.test.tsx` suites appear in unit/web collection. Transcript treatment tables still cover the full event union; the sole new omission is assertion data already rendered by the result card. No dependency, architecture table, hook or CI glob changed. The temporary review route is removed before committing. The backend's current-checkpoint, source and lease checks remain authoritative.

Final branch gates passed: 5,125 tests in 389 files, typecheck, lint, and production build. The final backend integration check also forced real context assembly through compaction: the active test prompt is reintroduced without becoming a permanent historical user request. Its regression test failed before the fix. Desktop/provider behavior remains fake-only.

## Click feedback follow-up

The local playground's recorded click completed in the queue in about 1.2 seconds, but the affected tab showed no visible change. Repeated fresh-tab checks, including dashboard navigation followed by reopening the project, received a new result on every click. The browser check counted result cards before and after each request, so an old Passed card could not satisfy it. The affected tab still appeared stuck after a reload; its missing update has not been reproduced or explained.

One feedback gap was reproduced independently at the live-pane seam: while the admission request and first event are pending, the approval card kept its original label and supplied no app-test progress. The card now immediately says **Starting app test…**, then **Testing the app…** once its own test start arrives. A named status explains where actions and results appear. This does not establish that the original missing-update problem is fixed.

The new live-pane regression failed on the missing progress status before implementation. The existing request-identity test now covers starting, running and idle test phases. The running local app also showed immediate progress, one additional result card, and removal of progress on completion. All 5,128 tests in 390 files, typecheck and lint passed. Lint retains the existing unrelated specificity warning and template-literal information. Collection includes the modified web suites; no dependencies, architecture rules, hooks or CI globs changed. Temporary local connection diagnostics were removed. The remaining investigation needs the affected tab's exact address and browser so its connection can be compared with the working one. No paid service was used.
