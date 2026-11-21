/**
 * The version each model line runs on, kept current from OpenRouter's catalog.
 *
 * Every process starts from the snapshot committed to the repo, so it knows a version for every
 * line before it has asked anybody. A process that serves requests then refreshes from OpenRouter
 * once at start and hourly after that; that is where turns are admitted and resolved to a version,
 * and so the only place the catalog is read. A worker runs whatever version was written on the row
 * it claims and never needs one.
 *
 * **A refresh never makes things worse.** A catalog that cannot be fetched, does not parse, or
 * lists nothing keeps the last good copy whole; a line the new catalog has no usable version of
 * keeps its last good version, because moving a line to nothing refuses every turn on it while the
 * version it was on most likely still works. Both say so in the log.
 *
 * What moved, what has nothing, and which families OpenRouter lists that no line claims are logged
 * when they change, so a new version or a new family is something somebody hears about.
 */

import { DEFAULT_MODEL_CONFIG } from "@nap/agent/claude-provider";
import { startSweeping } from "@nap/runtime/sweep-schedule";
import type { Logger } from "@nap/shared/logging";
import { SNAPSHOT_CATALOG } from "@nap/shared/model-catalog-snapshot";
import {
  CATALOG_URL,
  type CatalogModel,
  DEFAULT_EFFORT,
  type LineKey,
  type LineResolution,
  MODEL_LINES,
  parseCatalog,
  resolveLines,
  shapeProblems,
  unclaimedFamilies,
} from "@nap/shared/model-lines";
import type { Env } from "../env.ts";
import type { ModelPolicy } from "../turns/model-access.ts";

export const CATALOG_REFRESH_MS = 60 * 60 * 1_000;

/** Long enough for a slow answer, short enough that a hung one does not hold a refresh open. */
const FETCH_TIMEOUT_MS = 15_000;

/** A version listed this recently is marked new in the picker. */
const NEW_FOR_MS = 14 * 24 * 60 * 60 * 1_000;

export type ModelCatalogOptions = {
  /** The catalog a process knows before its first refresh. */
  snapshot: readonly CatalogModel[];
  /** `NAP_MODEL_PINS`: a version per line that wins over the catalog. */
  pins: Partial<Record<LineKey, string>>;
  /** The context budget plus the output ceiling: the smallest window a turn fits in. */
  minContextTokens: number;
  now: () => Date;
  logger: Logger;
};

export class ModelCatalog {
  readonly #options: ModelCatalogOptions;
  #lines: Record<LineKey, LineResolution>;
  /**
   * The unclaimed families the last refresh listed; null until the first. The snapshot holds only
   * what lines claim, so it says nothing of these, and taking it as the baseline would report every
   * family as new on every boot.
   */
  #families: Set<string> | null = null;
  /**
   * When each version any catalog so far said it would be withdrawn, in milliseconds. Kept across
   * refreshes, so a version announced as expiring and then left out of a later catalog is not kept
   * on past its date as though it had simply gone unlisted.
   */
  readonly #expiries = new Map<string, number>();

  constructor(options: ModelCatalogOptions) {
    this.#options = options;
    this.#lines = this.#resolve(options.snapshot);
    this.#remember(options.snapshot);
  }

  /** The exact version a line runs on now, or null when no version has ever passed. */
  versionOf(line: LineKey): string | null {
    return this.#lines[line].model;
  }

  /** Whether the line's version was listed recently enough to be called new. */
  isNew(line: LineKey): boolean {
    const created = this.#lines[line].created;
    if (created === null) return false;
    return this.#options.now().getTime() - created * 1_000 < NEW_FOR_MS;
  }

  /**
   * Replaces the catalog with what `fetchCatalog` answers, line by line, keeping the last good
   * version of anything the answer cannot serve. Never throws: true when the answer was used.
   */
  async refresh(fetchCatalog: () => Promise<unknown>): Promise<boolean> {
    const { logger } = this.#options;
    let body: unknown;
    try {
      body = await fetchCatalog();
    } catch (error) {
      logger.warn({ err: error }, "model catalog refresh failed; keeping the last good copy");
      return false;
    }

    const { models, unreadable } = parseCatalog(body);
    // Nothing readable at all is an outage or a change to the catalog's format, not news about any
    // one version, even if a line's current version is among the unreadable: a format change must
    // not darken all nine lines at once. With one readable row, an unreadable current version is
    // dropped below.
    if (models.length === 0) {
      logger.warn(
        { unreadable: unreadable.length },
        "model catalog listed no models; keeping the last good copy",
      );
      return false;
    }

    this.#remember(models);
    const next = this.#resolve(models);
    for (const line of MODEL_LINES) {
      const key = line.key;
      const before = this.#lines[key];
      const after = next[key];
      if (after.pinned) {
        // A pin wins whatever the check says — that is what a pin is for — but a pinned version
        // the check refuses is worth hearing about: a Luna pin that insists on reasoning fails
        // every title, and one priced above its weights lets a turn spend past its budget.
        const listed = models.find((model) => model.id === after.model);
        const problems =
          listed === undefined
            ? ["not listed in the catalog"]
            : shapeProblems(line, listed, this.#shapeOptions());
        if (problems.length > 0)
          logger.warn(
            { line: key, pinned: after.model, problems },
            "a pinned model version fails the shape check",
          );
        continue;
      }
      // The version the line is on is listed and no longer works: withdrawn, or now costing more
      // than the budget charges. Running on would be running what the check refuses. Expiry is
      // judged without the margin: that is for moving *onto* a version, and a line should not go
      // dark a fortnight before the version it is on actually stops answering.
      const listed = models.find((model) => model.id === before.model);
      const expires = before.model === null ? undefined : this.#expiries.get(before.model);
      const disqualified =
        (before.model !== null && unreadable.includes(before.model)) ||
        (expires !== undefined && expires <= this.#options.now().getTime()) ||
        (listed !== undefined &&
          shapeProblems(line, listed, { ...this.#shapeOptions(), expiryMarginMs: 0 }).length > 0);
      if (after.model === null && before.model !== null && !disqualified) {
        // Nothing usable, and the current version is simply not listed: a partial answer, most
        // likely. Stay where the line was, and say why the candidates were passed over.
        next[key] = before;
        logger.warn(
          { line: key, staying: before.model, skipped: after.skipped },
          "model line has no usable version in the catalog; keeping its last good version",
        );
      } else if (after.model === null) {
        logger.warn(
          { line: key, from: before.model, skipped: after.skipped },
          "model line has no usable version; turns on it are refused until one passes",
        );
      } else if (after.model !== before.model) {
        logger.info(
          { line: key, from: before.model, to: after.model, skipped: after.skipped },
          "model line moved to a new version",
        );
      }
    }
    this.#lines = next;

    const families = unclaimedFamilies(models);
    const known = this.#families;
    if (known === null) {
      // What this process starts from, said once and not as news.
      if (families.length > 0)
        logger.info({ families }, "the model catalog lists families no line claims");
    } else {
      const added = families.filter((family) => !known.has(family));
      if (added.length > 0)
        logger.info({ families: added }, "the model catalog lists a new family no line claims");
    }
    this.#families = new Set(families);
    return true;
  }

  #remember(catalog: readonly CatalogModel[]): void {
    for (const model of catalog) {
      const expires =
        model.expiration_date === null || model.expiration_date === undefined
          ? Number.NaN
          : Date.parse(model.expiration_date);
      if (!Number.isNaN(expires)) this.#expiries.set(model.id, expires);
    }
  }

  #shapeOptions() {
    return { now: this.#options.now(), minContextTokens: this.#options.minContextTokens };
  }

  #resolve(catalog: readonly CatalogModel[]): Record<LineKey, LineResolution> {
    return resolveLines(catalog, { ...this.#shapeOptions(), pins: this.#options.pins });
  }
}

/** Reads OpenRouter's catalog once, failing on anything but a 2xx. */
export function fetchCatalogWith(fetcher: typeof fetch): () => Promise<unknown> {
  return async () => {
    const response = await fetcher(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${CATALOG_URL} answered ${response.status}`);
    return response.json();
  };
}

/**
 * Refreshes now, then every `intervalMs`. The first refresh is not waited for: until it lands, the
 * snapshot answers, which is what it is for.
 */
export function startCatalogRefresh(options: {
  catalog: ModelCatalog;
  fetchCatalog: () => Promise<unknown>;
  intervalMs?: number;
}): { stop: () => void } {
  const refresh = () => options.catalog.refresh(options.fetchCatalog);
  void refresh();
  return startSweeping({ intervalMs: options.intervalMs ?? CATALOG_REFRESH_MS, sweep: refresh });
}

/**
 * The catalog and the policy every admitting route resolves a caller's choice against, for one
 * composition. Refreshed only when `fetchCatalog` is given — which the composition does only for a
 * role that admits turns — and never on a deployment that names its own model host
 * (`NAP_MODEL_BASE_URL`, an Ollama or a proxy): that one runs the exact ids it names and asks
 * OpenRouter nothing, so its lines, for keys people save, stay on the committed snapshot.
 */
export function composeModels(options: {
  config: Pick<Env, "NAP_FREE_MODEL" | "NAP_CONTEXT_BUDGET_TOKENS"> &
    Partial<Pick<Env, "NAP_EFFORT" | "NAP_MODEL_PINS" | "NAP_MODEL_BASE_URL">>;
  logger: Logger;
  fetchCatalog?: () => Promise<unknown>;
}): { catalog: ModelCatalog; policy: ModelPolicy; refresh: { stop: () => void } } {
  const { config, logger } = options;
  const catalog = new ModelCatalog({
    snapshot: SNAPSHOT_CATALOG,
    pins: config.NAP_MODEL_PINS ?? {},
    // The window a turn needs: the context it is assembled to plus the output it may write.
    minContextTokens: config.NAP_CONTEXT_BUDGET_TOKENS + DEFAULT_MODEL_CONFIG.maxTokens,
    now: () => new Date(),
    logger,
  });
  const ownHost = config.NAP_MODEL_BASE_URL !== undefined;
  if (ownHost && options.fetchCatalog !== undefined)
    logger.info(
      {},
      "model lines stay on the committed catalog snapshot: NAP_MODEL_BASE_URL is set, so OpenRouter is not asked",
    );
  const refresh =
    !ownHost && options.fetchCatalog !== undefined
      ? startCatalogRefresh({ catalog, fetchCatalog: options.fetchCatalog })
      : { stop: () => {} };
  const policy: ModelPolicy = {
    versionOf: (line) => catalog.versionOf(line),
    freeModel: config.NAP_FREE_MODEL,
    freeEffort: config.NAP_EFFORT ?? DEFAULT_EFFORT,
  };
  return { catalog, policy, refresh };
}
