/**
 * A picture of the project as it now stands, for the shelf the dashboard draws.
 *
 * The grid used to show a colour hashed from each project's id, because the two obvious
 * alternatives are both bad: a live preview in a card would boot the sandbox it claims to be
 * showing, and there is no way to photograph an app that is not running. This is the third
 * option — take the picture *while the sandbox is up*, at the one moment the project is known
 * to have just changed, and keep the bytes.
 *
 * **One key per project, overwritten.** Unlike a snapshot, nobody ever wants yesterday's
 * picture: there is nothing to restore from it and nothing that refers to it, so a second copy
 * would be an object nothing reads and somebody pays for. `ObjectStore.put` replaces, so the
 * key needs no timestamp and a delete needs no lookup.
 *
 * **The address comes from `waitForPreview`, not `getPreviewUrl`.** The second only composes a
 * string, and a screenshot of an address nothing answers at is a picture of an error page —
 * which would look exactly like the user's app being broken.
 */

import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { PageCapture } from "@nap/shared/ports/page-capture";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";

export type ThumbnailError = { message: string };

export type CaptureThumbnailOptions = {
  sandbox: SandboxManager;
  capture: PageCapture;
  objects: ObjectStore;
  projectId: string;
  sandboxId: string;
  /** The port the project's dev server listens on. */
  port: number;
  /**
   * How long to wait for the preview to answer.
   *
   * Shorter than the turn's own preview deadline on purpose: by the time this runs the dev
   * server has been serving the whole turn, so a preview that is not up now is not coming, and
   * waiting the full budget would hold a browser open for a picture nobody is waiting for.
   */
  previewTimeoutMs?: number;
};

const DEFAULT_PREVIEW_TIMEOUT_MS = 15_000;

/** Where a project's thumbnail lives. Derivable from the id, so a delete needs no row. */
export function thumbnailKey(projectId: string): string {
  return `projects/${projectId}/thumbnail.png`;
}

export async function captureThumbnail(
  options: CaptureThumbnailOptions,
): Promise<Result<{ key: string }, ThumbnailError>> {
  const { sandbox, capture, objects, projectId, sandboxId, port } = options;

  const preview = await sandbox.waitForPreview(sandboxId, port, {
    timeoutMs: options.previewTimeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS,
  });
  if (!preview.ok) {
    return { ok: false, error: { message: `no preview to photograph: ${preview.error.message}` } };
  }

  const shot = await capture.capture(preview.value);
  if (!shot.ok) {
    return { ok: false, error: { message: `could not capture the page: ${shot.error.message}` } };
  }

  const key = thumbnailKey(projectId);
  const stored = await objects.put(key, shot.value);
  if (!stored.ok) {
    return {
      ok: false,
      error: { message: `could not store the thumbnail: ${stored.error.message}` },
    };
  }

  return { ok: true, value: { key } };
}
