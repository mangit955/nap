/**
 * What `GET /models` answers with: the model lines, what this caller may run, and the defaults.
 *
 * A contract rather than an understanding, like `files-protocol.ts` and `ws-protocol.ts`: the
 * API and the browser are written separately and deploy separately, so the shape is defined
 * once here and validated at both ends.
 *
 * The lines come from `@nap/shared/model-lines` and their versions from the catalog the API
 * refreshes, through the same function the turn routes enforce. A picker built from anything
 * else offers lines every turn is then refused for naming.
 */

import { z } from "zod";
import { EffortSchema, LineKeySchema } from "./model-lines.ts";

export const ModelVendorSchema = z.enum(["openai", "anthropic", "meta"]);

export const LineChoiceSchema = z.strictObject({
  /** What a turn names. */
  key: LineKeySchema,
  label: z.string().min(1),
  vendor: ModelVendorSchema,
  /** The exact version a turn on this line runs now; null when no version passes. */
  version: z.string().min(1).nullable(),
  /** Listed recently: the picker's "New" badge. */
  isNew: z.boolean(),
  /** Whether this line may be sent images: attachments, screenshots, app tests. */
  images: z.boolean(),
  /** The effort levels it offers, lowest first. */
  efforts: z.array(EffortSchema).min(1),
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
export type LineChoice = z.infer<typeof LineChoiceSchema>;

/** The free tier's one model, for somebody with no key on a deployment that pays for them. */
export const FreeChoiceSchema = z.strictObject({
  /** The exact id a turn names. */
  id: z.string().min(1),
  label: z.string().min(1),
  images: z.boolean(),
});
export type FreeChoice = z.infer<typeof FreeChoiceSchema>;

/** What the browser needs to say "you are on the free model" without a second request. */
export const KeyStatusSchema = z.strictObject({
  configured: z.boolean(),
  /** Absent when nothing is saved. */
  platform: z.enum(["openrouter", "anthropic"]).optional(),
  /** A masked tail — never the key. Absent when nothing is saved. */
  hint: z.string().min(1).optional(),
});
export type KeyStatus = z.infer<typeof KeyStatusSchema>;

export const ModelListSchema = z.strictObject({
  lines: z.array(LineChoiceSchema).min(1),
  /** Present only when this caller has no key and the deployment has a free tier. */
  free: FreeChoiceSchema.nullable(),
  /** Whether this caller has brought a key, and which kind. */
  key: KeyStatusSchema,
  /**
   * What a turn runs on when it names nothing — for *this* caller: a line key, or the free
   * model's id. Null when this caller can run nothing at all.
   *
   * Sent rather than assumed to be the first entry: the picker has to show which model is
   * selected before anybody has chosen, and an OpenRouter key defaults to Sol while an Anthropic
   * key defaults to Opus.
   */
  fallback: z.string().min(1).nullable(),
  /** The effort a turn runs at when it names none. */
  effort: EffortSchema,
});
export type ModelList = z.infer<typeof ModelListSchema>;
