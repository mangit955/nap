/**
 * Rewrites the model catalog snapshot the API starts from, from OpenRouter's public catalog.
 *
 * A process reads the snapshot until its first refresh succeeds, so an API that boots while
 * OpenRouter is down still knows a version for every line. Keeping it current is not urgent —
 * a running API refreshes hourly — but a stale snapshot is what a fresh process runs on for its
 * first moments, so it is worth refreshing when a line moves. Free: the endpoint needs no key.
 *
 *   bun scripts/model-catalog-snapshot.ts
 */

import { writeFile } from "node:fs/promises";
import { CATALOG_URL, lineOf, parseCatalog } from "@nap/shared/model-lines";

const OUT = new URL("../packages/shared/src/model-catalog-snapshot.json", import.meta.url);

const response = await fetch(CATALOG_URL);
if (!response.ok) throw new Error(`${CATALOG_URL} answered ${response.status}`);
const { models, unreadable } = parseCatalog(await response.json());

// Only what a line claims: the rest is three hundred models nothing here reads.
const kept = models.filter((model) => lineOf(model.id) !== undefined);
kept.sort((a, b) => a.id.localeCompare(b.id));
await writeFile(OUT, `${JSON.stringify({ data: kept }, null, 2)}\n`);
console.log(
  `wrote ${kept.length} of ${models.length} models to ${OUT.pathname}` +
    (unreadable.length > 0 ? ` (${unreadable.length} entries did not parse)` : ""),
);
