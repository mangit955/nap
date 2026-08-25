/**
 * Taking the photographs: the one that falls out of a check, and the pass that is on purpose.
 *
 * Both live here because they share the rule that matters, and it is the rule that shapes every
 * line below: **a screenshot is evidence about a run, not an observation of the application.** A
 * browser that will not photograph, a surface that cannot be reached and a disk with no room on it
 * must all cost the run an image and nothing else. Nothing here returns a failure, because there
 * is no caller entitled to act on one — the gate ladder attributes what the *agent* did, and none
 * of this is that.
 *
 * The pass is the deliberate half. Screenshots used to be a by-product of browser checks, which
 * is right for a check and useless for a judge: `responsiveness` is graded by comparing one view
 * at two sizes, and nothing about a check's incidental photograph guarantees that pair exists.
 * So the pass walks the task's declared surfaces — see `surface.ts` — and photographs each of
 * them at both sizes, whatever the checks happened to look at.
 *
 * **A session per photograph.** The same isolation rule the checks answer to: a surface reached
 * by filling in a form must not be what makes the next surface look populated, and a pass that
 * reused one session would make every image depend on the order the plan happened to be in.
 *
 * **The pass runs after every check, and the cost of that is worth naming.** A surface's steps
 * drive the application, so a pass that ran first could add a row a check was about to assert was
 * absent — evidence-gathering silently deciding a score, which is the one thing it must never do.
 * Running last removes that entirely, and buys a smaller problem in exchange: whatever the checks
 * persisted is still there, so a surface called `empty` photographs an application the checks may
 * have filled. Fresh sessions clear client-side state and nothing clears the server's. A task
 * declaring surfaces is declaring them about the application *as its checks leave it*.
 */

import { reachSurface } from "./browser-executor.ts";
import type { BrowserSession, BrowserSessionFactory } from "./browser-session.ts";
import {
  type CapturedScreenshot,
  type CapturedSurface,
  refFromMetadata,
  type ScreenshotRef,
  type ScreenshotStore,
} from "./screenshot.ts";
import type { SurfaceCapture } from "./surface.ts";
import { viewportNameForSize } from "./viewport.ts";

/**
 * What a photograph is *of* — exactly one of the two, as the sidecar's schema insists.
 *
 * A union rather than two nullable fields, so the impossible states are unrepresentable here
 * rather than merely refused at the boundary.
 */
export type CaptureSubject =
  | { check: { id: string; referenceScreenshot?: string | undefined } }
  | { surface: CapturedSurface };

export type CaptureContext = {
  taskId: string;
  runId: string;
  /**
   * The clock, injectable for the reason the runner's is: `capturedAt` is a fact about a run that
   * has to be assertable, and `expect.any(String)` is not an assertion.
   */
  now: () => Date;
};

/**
 * Photographs whatever the session is showing, stores it, and says where it went.
 *
 * **Every failure returns undefined rather than propagating.** See this file's header: the
 * alternative is a full disk recorded as an agent that wrote a broken application, on a run that
 * has already been paid for.
 */
export async function captureScreenshot(
  session: BrowserSession,
  store: ScreenshotStore | undefined,
  subject: CaptureSubject,
  context: CaptureContext,
): Promise<ScreenshotRef | undefined> {
  if (store === undefined) return undefined;

  const shot = await session.screenshot();
  if (!shot.ok) return undefined;

  // Narrowed once. The three fields below are one decision about what this is a picture of, and
  // asking the same question three times inside an object literal is three chances to answer it
  // differently.
  const of =
    "check" in subject
      ? {
          checkId: subject.check.id,
          surface: null,
          reference: subject.check.referenceScreenshot ?? null,
        }
      : { checkId: null, surface: subject.surface, reference: null };

  const captured: CapturedScreenshot = {
    metadata: {
      taskId: context.taskId,
      runId: context.runId,
      ...of,
      viewport: {
        // The measured size decides the name, and nothing else does. A check may resize partway
        // through, so its declaration is not evidence about the page that was photographed — and
        // falling back to it for an unrecognised size would produce exactly the mislabelled
        // capture `viewportNameForSize` returns undefined to avoid. Null is the honest answer.
        //
        // A surface cannot resize itself, so this and `surface.viewport` normally agree — and on
        // the run where they do not, the disagreement is the finding.
        name: viewportNameForSize(shot.value.viewport) ?? null,
        ...shot.value.viewport,
      },
      capturedAt: context.now().toISOString(),
    },
    bytes: shot.value.bytes,
  };

  const stored = await store(captured);
  return stored.ok ? refFromMetadata(captured.metadata, stored.value) : undefined;
}

export type CapturePassDeps = {
  plan: readonly SurfaceCapture[];
  /** Where the application is actually being served, this run. */
  baseUrl: string;
  browser: BrowserSessionFactory;
  store: ScreenshotStore;
} & CaptureContext;

/**
 * Photographs every surface in the plan, at every size the plan asked for.
 *
 * Returns whatever it managed, in plan order, and **never fewer than nothing** — a pass that got
 * no images at all is a report with no product evidence, which is a run the judge answers
 * `not_assessable` on rather than a run that failed.
 *
 * **The one early exit is a browser that will not open**, and it is an economy rather than a
 * judgement: every remaining entry would ask the same absent browser the same question and pay
 * the same timeout to hear the same answer. A surface that cannot be *reached* is different —
 * that is one view being unreachable, and the next one may not be — so the pass carries on.
 */
export async function runCapturePass(deps: CapturePassDeps): Promise<ScreenshotRef[]> {
  const refs: ScreenshotRef[] = [];

  for (const entry of deps.plan) {
    const opened = await deps.browser();
    if (!opened.ok) return refs;

    try {
      const reached = await reachSurface(opened.value, entry, { baseUrl: deps.baseUrl });
      if (!reached.ok) continue;

      const ref = await captureScreenshot(
        opened.value,
        deps.store,
        { surface: { id: entry.surfaceId, viewport: entry.viewport } },
        deps,
      );
      if (ref !== undefined) refs.push(ref);
    } finally {
      // On every path, including the one that skipped the photograph: a browser left open holds
      // a process, and a pass is two images per surface.
      await opened.value.close();
    }
  }

  return refs;
}
