/**
 * Screenshots as archived artefacts: what is kept beside an image so that it still means
 * something months later, and where it goes.
 *
 * A PNG on its own is nearly useless to a benchmark. The same page photographed at 375px and at
 * 1280px are different claims, and a picture that cannot be traced to the check that produced it
 * cannot be compared against the same check on another model. So every image is written with a
 * sidecar naming the task, the run, the check, the size and the moment — which is also precisely
 * what a later visual judge needs in order to be handed the right pairs.
 *
 * **The size recorded is the size measured, not the size declared.** A browser check may resize
 * mid-sequence, so the viewport a check *ran at* is only knowable by asking the page afterwards.
 * The `BrowserSession` port returns it with the bytes for that reason, and this carries it
 * through unchanged rather than re-deriving it from the check's declaration.
 *
 * **Paths here are relative to the results directory, always.** A report referencing screenshots
 * by absolute path would be wrong the first time somebody moved or archived the directory, which
 * is the same rule that keeps a report from pointing at its own trajectory. Resolving a relative
 * name against a root is the app's job; this package touches no filesystem.
 */

import type { Result } from "@nap/shared/result";
import { z } from "zod";
import { describeParseFailure } from "./parse-failure.ts";
import { ViewportNameSchema } from "./viewport.ts";

/**
 * The size a screenshot was taken at, named *and* measured.
 *
 * Both, because they answer different questions: the name is what a task asked for and what two
 * runs are compared across, and the numbers are what the page was actually laid out at. Keeping
 * only the name would lose the measurement; keeping only the numbers would make a report
 * unreadable without the viewport table beside it.
 */
export const CapturedViewportSchema = z.strictObject({
  /**
   * Null for a size that is none of the named ones.
   *
   * Nullable rather than defaulted, because the alternative is the one thing `viewportNameForSize`
   * refuses to do: a capture labelled `mobile` at 800px wide is a lie that reads exactly like a
   * measurement, and the check's *declaration* is not evidence about a page that resized itself
   * afterwards. A reader with no name still has the numbers; a reader with the wrong name has
   * nothing, and does not know it.
   */
  name: ViewportNameSchema.nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export type CapturedViewport = z.infer<typeof CapturedViewportSchema>;

/**
 * An id that is safe to build a filename out of.
 *
 * Task and check ids come from hand-written task modules, so this is not untrusted input — but a
 * `/` or a `..` in one would silently write the image somewhere other than the results directory
 * and leave the report's relative path pointing at nothing. Cheaper to refuse here than to
 * discover it in an archive.
 *
 * Exported because a check id is no longer the only thing a filename is built out of: a surface
 * is named by the task and photographed under that name, and the two must answer to one rule or
 * the archive gets a hole in exactly the half nobody tested.
 */
export const FilenameSafeIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9._-]+$/, "must contain only letters, digits, dots, dashes and underscores")
  .refine((id) => id !== "." && id !== "..", { message: "must not be a path segment" });

/**
 * The surface a photograph is *of*, as the task named it and at the size it was asked for.
 *
 * The requested viewport rather than the measured one, and both are kept: the measurement is in
 * `viewport` beside this, and it is what the page was actually laid out at. This is what *pairs*
 * two images. A judge grading responsiveness needs to know that two files are the same view at
 * two sizes, and it cannot learn that from measurements — a page that resized itself comes back
 * with a null name, and two images of one surface would stop being a pair at the moment the
 * comparison became interesting.
 */
export const CapturedSurfaceSchema = z.strictObject({
  id: FilenameSafeIdSchema,
  viewport: ViewportNameSchema,
});

export type CapturedSurface = z.infer<typeof CapturedSurfaceSchema>;

/**
 * Whether a photograph says what it is a picture of — exactly one of a check and a surface.
 *
 * Neither is a photograph nobody can attribute; both is a photograph claiming to be two kinds of
 * evidence at once, which is worse — a judge would be handed a check's incidental image as if
 * somebody had asked for that view at that size.
 *
 * One predicate for both the sidecar and the report's reference, rather than the same comparison
 * written twice: two encodings of one invariant are two things to keep in step.
 */
function namesExactlyOneSubject(capture: {
  checkId: string | null;
  surface: CapturedSurface | null;
}): boolean {
  return (capture.checkId === null) !== (capture.surface === null);
}

/**
 * The message both refines refuse with.
 *
 * A function rather than a shared object, for the reason the report's `configuration` default is
 * one: a single literal handed to two schemas is a single object either of them could edit.
 */
function exactlyOneSubject() {
  return {
    message: "a capture names exactly one of a check and a surface",
    path: ["surface"],
  };
}

/**
 * Everything written beside an image, so the image is interpretable on its own.
 *
 * **Exactly one of `checkId` and `surface`**, because there are exactly two reasons a photograph
 * exists and they are read differently. A check's is a by-product — the page as that check left
 * it, at whatever size it finished at — and is evidence about the check. A surface's is
 * deliberate: somebody asked for this view at this size, which is what makes it comparable to the
 * same view at the other size and to the same view on another model's run. Collapsing them into
 * one nullable label would make a report unable to say which kind of artefact it is holding.
 */
export const ScreenshotMetadataSchema = z
  .strictObject({
    taskId: FilenameSafeIdSchema,
    runId: z.uuid(),
    /**
     * Which check produced it, or null on a capture the pass took. One check, one screenshot,
     * taken after its last step.
     */
    checkId: FilenameSafeIdSchema.nullable(),
    /**
     * Which surface this is a photograph of, or null on a check's by-product.
     *
     * Defaulted rather than required for the one reason the archive earns: sidecars written
     * before surfaces existed must still parse, or a directory stops being readable by the tool
     * that wrote it. Everything that writes one states it explicitly, on the same terms as
     * `halves` and `product` in `report.ts`, so the default is only ever reached by an older
     * file — a report that says what it is beats a parser deciding later.
     */
    surface: CapturedSurfaceSchema.nullable().default(null),
    viewport: CapturedViewportSchema,
    capturedAt: z.iso.datetime(),
    /**
     * The reference image this check declared, or null.
     *
     * Recorded with the capture rather than only in the task, because a comparison run months
     * later needs to know what this was *meant* to look like at the time — a task file edited
     * since would otherwise silently repoint every historical screenshot at a new reference.
     */
    reference: z.string().nullable(),
  })
  .refine(namesExactlyOneSubject, exactlyOneSubject());

export type ScreenshotMetadata = z.infer<typeof ScreenshotMetadataSchema>;

/**
 * A path inside the results directory, checked rather than merely asserted.
 *
 * The rule the whole archival story rests on — see this file's header — so it is a boundary
 * guarantee rather than a convention several comments repeat. Anything validated on the way back
 * in is untrusted input, and an absolute path in one is a report that stopped being portable.
 *
 * Exported because a screenshot reference is no longer the only thing that points at one: a
 * product judgement cites the image its evidence came from, and the two must agree about what a
 * legal path is or an archive can be moved and only half of it will still resolve.
 */
export const ResultsRelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(value), {
    message: "must be relative to the results directory, not absolute",
  })
  .refine((value) => !value.split(/[\\/]/).includes(".."), {
    message: "must not climb out of the results directory",
  });

/**
 * What a report carries per screenshot.
 *
 * Narrower than the sidecar: a report already states its own task and run, so repeating them
 * per image would be three copies of one fact and a way for a hand-edited file to contradict
 * itself. The sidecar repeats them because it is read *without* the report beside it.
 */
export const ScreenshotRefSchema = z
  .strictObject({
    /** Which check left it behind, or null on one the capture pass asked for. */
    checkId: z.string().min(1).nullable(),
    /**
     * Which surface it is a photograph of, or null on a check's by-product.
     *
     * This is what lets a judge be handed like-for-like pairs from the report alone, without
     * decoding filenames or reading a sidecar per image. Defaulted for the archive's sake, on
     * the same terms as `halves` and `product` on the report itself: a run recorded before
     * surfaces existed took none, and must still parse.
     */
    surface: CapturedSurfaceSchema.nullable().default(null),
    viewport: CapturedViewportSchema,
    /**
     * Relative to the results directory, and checked rather than merely asserted.
     *
     * The rule the whole archival story rests on — see this file's header — so it is a boundary
     * guarantee rather than a convention four comments repeat. A report validated on the way back
     * in is untrusted input, and an absolute path in one is a report that stopped being portable.
     */
    path: ResultsRelativePathSchema,
    capturedAt: z.iso.datetime(),
  })
  // The sidecar's rule, and literally the same predicate: a report and the sidecars beside it
  // must not be able to disagree about what a photograph is of.
  .refine(namesExactlyOneSubject, exactlyOneSubject());

export type ScreenshotRef = z.infer<typeof ScreenshotRefSchema>;

/** An image and the facts about it, on the way to being stored. */
export type CapturedScreenshot = {
  metadata: ScreenshotMetadata;
  /** PNG bytes, as the `BrowserSession` port produced them. */
  bytes: Uint8Array;
};

/**
 * Where captured screenshots go.
 *
 * A port, because writing files is the app's half — see `docs/adr/0001` — and a `Result` rather
 * than a throw because **failing to keep a screenshot must never change a score.** An image is
 * evidence about a run, not an observation of the application, so a full disk has to degrade the
 * report rather than fail the run that already paid for a model.
 *
 * Returns the path it wrote, relative to the results directory.
 */
export type ScreenshotStore = (screenshot: CapturedScreenshot) => Promise<Result<string, string>>;

/**
 * The image's name: task, run, and whichever of a check or a surface it is a photograph of.
 *
 * The task id makes a directory listing readable at a glance, the run id keeps two runs of one
 * task apart — the whole point of running one twice — and the last part keeps the several
 * screenshots within a run apart. The same convention the report and trajectory already use.
 *
 * A surface's name carries its viewport, because a surface is photographed twice on purpose and
 * the two images differ in nothing else. The two namespaces are kept apart by `@`, which is the
 * one thing here a check id cannot contain — `FilenameSafeIdSchema` allows letters, digits, dots,
 * dashes and underscores and nothing else. So a check called `surface-home-mobile` still cannot
 * overwrite the mobile capture of the surface `home`; separating them with a character an id may
 * legally contain would have made that claim wishful rather than true.
 */
export function screenshotFilename(metadata: ScreenshotMetadata): string {
  const subject =
    metadata.surface === null
      ? metadata.checkId
      : `surface@${metadata.surface.id}@${metadata.surface.viewport}`;

  return `${metadata.taskId}-${metadata.runId}-${subject}.png`;
}

/**
 * The sidecar's name: the image's, with `.json` after it.
 *
 * After rather than instead of `.png`, so that sorting a directory puts the pair together and
 * neither can be mistaken for the artefact of a check called `<something>.png`.
 */
export function screenshotMetadataFilename(metadata: ScreenshotMetadata): string {
  return `${screenshotFilename(metadata)}.json`;
}

/** The report's view of a stored screenshot, given where it actually went. */
export function refFromMetadata(metadata: ScreenshotMetadata, path: string): ScreenshotRef {
  return {
    checkId: metadata.checkId,
    surface: metadata.surface,
    viewport: metadata.viewport,
    path,
    capturedAt: metadata.capturedAt,
  };
}

export function parseScreenshotMetadata(input: unknown): Result<ScreenshotMetadata, string> {
  const parsed = ScreenshotMetadataSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };

  return { ok: false, error: describeParseFailure(parsed.error, "screenshot") };
}
