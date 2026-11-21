/**
 * The model lines this deployment runs, and which of them this caller may.
 *
 * The picker in the browser is populated from here rather than from a list compiled into it,
 * because a line's version moves with the catalog and the browser cannot know it — and because
 * which lines a caller may run is the turn route's rule, answered here by the same function. A
 * menu built from anything else offers lines every turn is then refused for naming.
 */

import { modelSupportsImages } from "@nap/shared/model-capabilities";
import { DEFAULT_EFFORT, type LineKey, MODEL_LINES } from "@nap/shared/model-lines";
import { ModelListSchema } from "@nap/shared/models-protocol";
import type { StoredKeyRecord } from "@nap/shared/ports/user-key-store";
import type { Hono } from "hono";
import type { AuthVariables } from "../auth/require-user.ts";
import { defaultLine, type ModelPolicy, reachableWith } from "../turns/model-access.ts";

export type ModelRouteDeps = {
  policy: ModelPolicy;
  /** Which lines' versions were listed recently enough to be called new. */
  isNew: (line: LineKey) => boolean;
  /**
   * The key this caller brought, if any. Absent means nobody has one — which is what an app
   * assembled without a key store means, and is the answer that offers least.
   */
  keys?: (userId: string) => Promise<StoredKeyRecord | null>;
};

export function registerModelRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  deps: ModelRouteDeps,
): void {
  app.get("/models", async (c) => {
    const stored = (await deps.keys?.(c.get("userId"))) ?? null;
    // Only the platform matters here; the key itself is never opened for this, because
    // nothing on this route needs to spend it.
    const platform = stored?.platform;
    const { policy } = deps;
    const freeModel = stored === null ? policy.freeModel : undefined;

    return c.json(
      ModelListSchema.parse({
        lines: MODEL_LINES.map((line) => {
          const version = policy.versionOf(line.key);
          return {
            key: line.key,
            label: line.label,
            vendor: line.vendor,
            version,
            isNew: deps.isNew(line.key),
            images: line.images,
            efforts: [...line.efforts],
            available:
              platform !== undefined && version !== null && reachableWith(line.key, platform),
          };
        }),
        free:
          freeModel === undefined
            ? null
            : {
                id: freeModel,
                label: modelLabel(freeModel),
                images: modelSupportsImages(freeModel),
              },
        // Whichever default this caller's turns would actually take, so the tick in the menu
        // is on the model a message would really run on.
        fallback: platform === undefined ? (freeModel ?? null) : defaultLine(platform, policy),
        effort: platform === undefined ? policy.freeEffort : DEFAULT_EFFORT,
        key:
          stored === null
            ? { configured: false }
            : { configured: true, platform: stored.platform, hint: stored.hint },
      }),
    );
  });
}

/**
 * A model id as somebody would say it out loud.
 *
 * `anthropic/claude-opus-5` is a route and a product name joined by a slash; the vendor prefix
 * is the part that never distinguishes anything in a list this short, so it goes. What is left
 * is title-cased at the hyphens, which turns every id this project runs into its real name and
 * leaves anything unfamiliar legible rather than mangled.
 *
 * The `:free` suffix goes too. It is a fact about price rather than part of a product's name,
 * it travels to the browser as its own field, and left in the label the menu says it twice —
 * once as punctuation in the middle of a name, once as the marker beside it.
 */
export function modelLabel(id: string): string {
  const withoutVendor = id.includes("/") ? (id.split("/")[1] ?? id) : id;

  return (
    withoutVendor
      .replace(/:free$/, "")
      // Split on hyphens only. A dot is part of a version — splitting there turns `gpt-5.6-luna`
      // into "Gpt 5 6 Luna", which reads as a different model from the one people asked for.
      .split("-")
      .filter((part) => part !== "")
      .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join(" ")
  );
}
