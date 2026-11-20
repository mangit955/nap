/**
 * The catalog a process knows before its first refresh: OpenRouter's entries for every line,
 * committed to the repo by `bun scripts/model-catalog-snapshot.ts`. An API that boots while
 * OpenRouter is down still runs every line on the version this says.
 */

import snapshot from "./model-catalog-snapshot.json";
import { type CatalogModel, parseCatalog } from "./model-lines.ts";

export const SNAPSHOT_CATALOG: readonly CatalogModel[] = parseCatalog(snapshot).models;
