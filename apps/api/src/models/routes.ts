/**
 * Which models this deployment will run a turn on.
 *
 * The picker in the browser is populated from here rather than from a list compiled into it,
 * because the two would drift the moment `NAP_ALLOWED_MODELS` changed — and they would drift
 * silently, into a menu offering a model every turn is then refused for naming. One source,
 * and it is the same list the turn route enforces.
 *
 * Labels are derived rather than configured. A second environment variable pairing ids with
 * display names is a second thing to keep in step with the first, and the id already carries
 * everything a person needs to tell two models apart.
 */

import { ModelListSchema } from "@nap/shared/models-protocol";
import type { Hono } from "hono";
import type { AuthVariables } from "../auth/require-user.ts";

export type ModelRouteDeps = {
  allowed: readonly string[];
  /** What a turn runs on when it names nothing, which is the normal case. */
  fallback: string;
};

export function registerModelRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  deps: ModelRouteDeps,
): void {
  app.get("/models", (c) =>
    c.json(
      ModelListSchema.parse({
        models: deps.allowed.map((id) => ({
          id,
          label: modelLabel(id),
          // OpenRouter's convention. Worth saying in the menu, because it is the difference
          // between a turn that costs money and one that does not.
          free: id.endsWith(":free"),
        })),
        fallback: deps.fallback,
      }),
    ),
  );
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
