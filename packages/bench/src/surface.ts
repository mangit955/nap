/**
 * Surfaces: the views a task wants photographed, and the plan that photographs them.
 *
 * **Why this exists.** Screenshots were a by-product of browser checks — taken at the end of one,
 * at whatever size that check happened to finish at. That is the right thing for evidence about a
 * check, and the wrong thing entirely for a judge. Grading `responsiveness` means comparing *one
 * view* at two sizes, and nothing about a check's incidental photograph guarantees that pair
 * exists: a check is named for what it asserts rather than for what it is looking at, and a task
 * with one desktop check produces one desktop image and no comparison at all.
 *
 * So a surface is declared, not inferred. It is a name plus the steps needed to reach a state
 * worth looking at — an empty list, a populated one, a detail view — and the pass photographs
 * every one of them at both of `CAPTURE_VIEWPORTS`. A task that declares none still gets the
 * default pair, because "nobody thought about surfaces" must not mean "nothing to judge".
 *
 * **Steps are the existing browser vocabulary, minus two things.** Reuse is the point: the pass
 * is drivable by `ScriptedBrowserSession` with no Chrome anywhere, exactly as every check is. But
 * assertions are refused, because a capture pass has nowhere to put a failed one — a surface is
 * evidence, not a check, and failing a run over an unscored assertion is the mistake docs/adr/0005
 * is about. And `viewport` is refused, because the pass owns the size: a surface that resized
 * itself would produce two images of one viewport, one of them labelled with the size it was
 * asked for rather than the size it is.
 *
 * **The image count is bounded, and the bound is the reason.** Every captured image is vision-model
 * tokens on every real run, and a judge is handed the surface captures rather than the checks'
 * by-products. `MAX_SURFACES_PER_TASK` times the pair is therefore the whole of what a task can
 * cost a judge, and it is enforced by the task schema rather than by anybody remembering.
 */

import { z } from "zod";
import { type BrowserStep, BrowserStepSchema, isAssertion } from "./browser-check.ts";
import { FilenameSafeIdSchema } from "./screenshot.ts";
import type { BenchTask } from "./task.ts";
import type { ViewportName } from "./viewport.ts";

/**
 * The pair every surface is photographed at.
 *
 * Two sizes rather than three: `responsiveness` asks whether the small viewport was designed for
 * or the large one squashed, and that question is answered at the extremes. Tablet sits between
 * them and would add half again to the token bill for a grade nobody reads differently.
 */
export const CAPTURE_VIEWPORTS = ["mobile", "desktop"] as const satisfies readonly ViewportName[];

/**
 * How many surfaces a task may declare.
 *
 * Four because it is enough to say something — empty, populated, a detail view, one more — and
 * because the ceiling below is what a real run pays for. It is a schema rule rather than advice,
 * since the cost lands on somebody else's afternoon.
 */
export const MAX_SURFACES_PER_TASK = 4;

/** The stated ceiling on a task's judged images: every surface, at both sizes. */
export const MAX_CAPTURES_PER_TASK = MAX_SURFACES_PER_TASK * CAPTURE_VIEWPORTS.length;

/**
 * A view worth photographing: a name, and how to get there.
 *
 * Steps are optional because the commonest surface is the application as it loads, and making
 * every task spell out a navigation to `/` would be ceremony that can be got wrong.
 */
export const SurfaceSchema = z.strictObject({
  /**
   * As the judge will cite it — `empty`, `populated`, `detail`.
   *
   * Filename-safe for the reason a check id is: it names an image in the results directory, and
   * a `/` in one would write it somewhere the report's relative path does not point.
   */
  id: FilenameSafeIdSchema,
  steps: z
    .array(BrowserStepSchema)
    .refine((steps) => !steps.some(isAssertion), {
      message: "must not assert anything — a surface is evidence, not a check",
    })
    .refine((steps) => !steps.some((step) => step.step === "viewport"), {
      message: "must not set a viewport — the capture pass photographs every surface at both",
    })
    .optional(),
});

export type Surface = z.infer<typeof SurfaceSchema>;

/** The surface a task gets when it declares none: the application as it opens. */
export const DEFAULT_SURFACE_ID = "home";

const DEFAULT_SURFACES: readonly Surface[] = [{ id: DEFAULT_SURFACE_ID }];

/**
 * One photograph the pass intends to take.
 *
 * The viewport is the one *asked for* rather than the one measured — the measurement comes back
 * with the bytes and goes into the sidecar. Both are kept, for the reason `CapturedViewport`
 * keeps both: the requested name is what pairs two images, and the measurement is what the page
 * was actually laid out at.
 */
export type SurfaceCapture = {
  surfaceId: string;
  viewport: ViewportName;
  steps: readonly BrowserStep[];
};

/** What a task wants photographed: what it declared, or the default pair's surface. */
export function surfacesOf(task: BenchTask): readonly Surface[] {
  return task.surfaces ?? DEFAULT_SURFACES;
}

/**
 * Every photograph a task's capture pass will attempt, in the order it will attempt them.
 *
 * Surface-major, so a surface's two sizes are adjacent: the pair is the unit a judge reasons
 * about, and an ordering that split it would make a truncated run's screenshots useless for the
 * one dimension they exist to support.
 */
export function capturePlan(task: BenchTask): SurfaceCapture[] {
  return surfacesOf(task).flatMap((surface) =>
    CAPTURE_VIEWPORTS.map((viewport) => ({
      surfaceId: surface.id,
      viewport,
      steps: surface.steps ?? [],
    })),
  );
}
