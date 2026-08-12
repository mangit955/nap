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
});
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;

export const ModelListSchema = z.strictObject({
  models: z.array(ModelChoiceSchema).min(1),
  /**
   * What a turn runs on when it names nothing.
   *
   * Sent rather than assumed to be the first entry: the picker has to show which model is
   * selected before anybody has chosen, and guessing that from list order would put a tick
   * against the wrong one every time the allowlist was reordered.
   */
  fallback: z.string().min(1),
});
export type ModelList = z.infer<typeof ModelListSchema>;
