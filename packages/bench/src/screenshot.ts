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
 */
const FilenameSafeIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9._-]+$/, "must contain only letters, digits, dots, dashes and underscores")
  .refine((id) => id !== "." && id !== "..", { message: "must not be a path segment" });

/** Everything written beside an image, so the image is interpretable on its own. */
export const ScreenshotMetadataSchema = z.strictObject({
  taskId: FilenameSafeIdSchema,
  runId: z.uuid(),
  /** Which check produced it. One check, one screenshot, taken after its last step. */
  checkId: FilenameSafeIdSchema,
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
});

export type ScreenshotMetadata = z.infer<typeof ScreenshotMetadataSchema>;

/**
 * What a report carries per screenshot.
 *
 * Narrower than the sidecar: a report already states its own task and run, so repeating them
 * per image would be three copies of one fact and a way for a hand-edited file to contradict
 * itself. The sidecar repeats them because it is read *without* the report beside it.
 */
export const ScreenshotRefSchema = z.strictObject({
  checkId: z.string().min(1),
  viewport: CapturedViewportSchema,
  /**
   * Relative to the results directory, and checked rather than merely asserted.
   *
   * The rule the whole archival story rests on — see this file's header — so it is a boundary
   * guarantee rather than a convention four comments repeat. A report validated on the way back
   * in is untrusted input, and an absolute path in one is a report that stopped being portable.
   */
  path: z
    .string()
    .min(1)
    .refine((value) => !value.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(value), {
      message: "must be relative to the results directory, not absolute",
    })
    .refine((value) => !value.split(/[\\/]/).includes(".."), {
      message: "must not climb out of the results directory",
    }),
  capturedAt: z.iso.datetime(),
});

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
 * The image's name: task, run and check.
 *
 * The task id makes a directory listing readable at a glance, the run id keeps two runs of one
 * task apart — the whole point of running one twice — and the check id keeps the several
 * screenshots within a run apart. The same convention the report and trajectory already use.
 */
export function screenshotFilename(metadata: ScreenshotMetadata): string {
  return `${metadata.taskId}-${metadata.runId}-${metadata.checkId}.png`;
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
