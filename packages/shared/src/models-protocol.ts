/**
 * What `GET /models` answers with.
 *
 * A contract rather than an understanding, like `files-protocol.ts` and `ws-protocol.ts`: the
 * API and the browser are written separately and deploy separately, so the shape is defined
 * once here and validated at both ends.
 *
 * The list is the deployment's allowlist, which is the same list the turn route enforces. A
 * picker built from anything else offers models every turn is then refused for naming.
 */

import { z } from "zod";

export const ModelChoiceSchema = z.strictObject({
  /** The id a turn names. Fully namespaced, the way this codebase spells a model everywhere. */
  id: z.string().min(1),
  /** The id said out loud, for the menu. Derived by the server so one place decides. */
  label: z.string().min(1),
  /**
   * Whether this one costs nothing.
   *
   * Sent rather than sniffed from the id in the browser: the `:free` suffix is OpenRouter's
   * convention, and a client that learned to read it would be a second place that has to be
   * updated when the route's idea of free changes.
   */
  free: z.boolean(),
  /**
   * Whether *this* caller may actually run it.
   *
   * The list stays complete and the unavailable entries are marked rather than removed: a menu
   * that silently shortens makes the product look smaller than it is, and gives somebody no
   * way to discover that Opus is a key away. The turn route enforces the same rule from the
   * same function, so the two cannot say different things.
   */
  available: z.boolean(),
});
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;

/** What the browser needs to say "you are on the free models" without a second request. */
export const KeyStatusSchema = z.strictObject({
  configured: z.boolean(),
  /** Absent when nothing is saved. */
  platform: z.enum(["openrouter", "anthropic"]).optional(),
  /** A masked tail — never the key. Absent when nothing is saved. */
  hint: z.string().min(1).optional(),
});
export type KeyStatus = z.infer<typeof KeyStatusSchema>;

export const ModelListSchema = z.strictObject({
  models: z.array(ModelChoiceSchema).min(1),
  /** Whether this caller has brought a key, and which kind. */
  key: KeyStatusSchema,
  /**
   * What a turn runs on when it names nothing — for *this* caller.
   *
   * Sent rather than assumed to be the first entry: the picker has to show which model is
   * selected before anybody has chosen, and guessing that from list order would put a tick
   * against the wrong one every time the allowlist was reordered. It is per-caller for the
   * same reason the availability flags are — somebody with no key falls back to a free model,
   * not to the deployment's default.
   */
  fallback: z.string().min(1),
});
export type ModelList = z.infer<typeof ModelListSchema>;
