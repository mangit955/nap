/**
 * Model lines: what a person picks, and how each turn finds the version it runs on.
 *
 * A line is a family a vendor keeps shipping new versions of — Sol, Opus, Muse Ember. People pick
 * the line, and a turn runs the newest version of it that OpenRouter lists and that passes the
 * shape check below. When a vendor ships `gpt-6.3-sol`, the next catalog refresh moves Sol to it,
 * with no deploy and no list for anybody to edit.
 *
 * Two rules decide a version, and each exists because the catalog is somebody else's data:
 *
 *  - **An anchored pattern per line.** The catalog lists `:batch` routes, `-pro` variants and
 *    `-contributor` builds beside every model; a pattern that is not anchored at the end matched
 *    forty such ids on 2026-11-19. The version is the number the pattern captures. The highest
 *    wins; an id with no number counts as the oldest, and a tie goes to the newer `created`.
 *  - **A shape check.** A version is usable only if it can do what a turn does: call tools,
 *    reason, read images when the line promises them, fit the context and output a turn needs,
 *    offer every effort level the line offers, stay listed for a while, and cost no more per
 *    token, relative to its input price, than the turn budget charges for it. A version that
 *    fails is skipped, and the line falls back to the newest one that passes.
 *
 * Pure: the catalog and the clock are arguments, so every rule is a table in a test.
 */

import { z } from "zod";
import { billedWeightsFor } from "./usage.ts";

/** How hard a model is asked to think, lowest first. Every line offers all five. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const EffortSchema = z.enum(EFFORTS);
export type Effort = z.infer<typeof EffortSchema>;

/**
 * What a turn runs at when the person names no effort. Measured rather than chosen: fifteen turns
 * over five prompts found it the cheapest and fastest level, and no worse (PROGRESS.md, F-4).
 */
export const DEFAULT_EFFORT: Effort = "medium";

export type ModelVendor = "openai" | "anthropic" | "meta";

export type ModelLine = {
  key: string;
  /** How the picker names it. */
  label: string;
  vendor: ModelVendor;
  /**
   * The ids that belong to this line, as OpenRouter spells them. Anchored at both ends, with the
   * version, when the id carries one, as the first capture.
   */
  pattern: RegExp;
  /**
   * Whether turns on this line may be sent images: screenshots, attachments, the computer tool.
   * On only once a real request with an image inside a tool result has worked on the line's
   * newest version, which is the shape the computer tool sends — a catalog that says
   * `image` is not the same as a route that accepts one there.
   */
  images: boolean;
  /**
   * Whether a version may refuse requests with reasoning off. Off for the two lines session
   * titles are written on, because a title is asked for with thinking disabled and a version
   * that insists on reasoning answers that with a 400.
   */
  reasoningMayBeRequired: boolean;
  /** The effort levels the picker offers on this line. A version must offer every one. */
  efforts: readonly Effort[];
};

/**
 * The nine lines, in picker order: by vendor, then strongest first.
 *
 * Images are on for every line: on 2026-11-20 each line's newest version described a screenshot
 * sent inside a tool result, through OpenRouter, correctly. A line added later starts with them off
 * until it has done the same.
 */
export const MODEL_LINES = [
  {
    key: "astra",
    label: "Astra",
    vendor: "openai",
    pattern: /^openai\/gpt-(\d+(?:\.\d+)*)-astra$/,
    images: true,
    reasoningMayBeRequired: true,
    efforts: EFFORTS,
  },
  {
    key: "sol",
    label: "Sol",
    vendor: "openai",
    pattern: /^openai\/gpt-(\d+(?:\.\d+)*)-sol$/,
    images: true,
    reasoningMayBeRequired: true,
    efforts: EFFORTS,
  },
  {
    key: "luna",
    label: "Luna",
    vendor: "openai",
    pattern: /^openai\/gpt-(\d+(?:\.\d+)*)-luna$/,
    images: true,
    reasoningMayBeRequired: false,
    efforts: EFFORTS,
  },
  {
    key: "fable",
    label: "Fable",
    vendor: "anthropic",
    pattern: /^anthropic\/claude-fable-(\d+(?:\.\d+)*)$/,
    images: true,
    reasoningMayBeRequired: true,
    efforts: EFFORTS,
  },
  {
    key: "opus",
    label: "Opus",
    vendor: "anthropic",
    pattern: /^anthropic\/claude-opus-(\d+(?:\.\d+)*)$/,
    images: true,
    reasoningMayBeRequired: true,
    efforts: EFFORTS,
  },
  {
    key: "sonnet",
    label: "Sonnet",
    vendor: "anthropic",
    pattern: /^anthropic\/claude-sonnet-(\d+(?:\.\d+)*)$/,
    images: true,
    reasoningMayBeRequired: true,
    efforts: EFFORTS,
  },
  {
    key: "haiku",
    label: "Haiku",
    vendor: "anthropic",
    pattern: /^anthropic\/claude-haiku-(\d+(?:\.\d+)*)$/,
    images: true,
    reasoningMayBeRequired: false,
    efforts: EFFORTS,
  },
  {
    key: "muse-wonder",
    label: "Muse Wonder",
    vendor: "meta",
    pattern: /^meta\/muse-wonder(?:-(\d+(?:\.\d+)*))?$/,
    images: true,
    reasoningMayBeRequired: true,
    efforts: EFFORTS,
  },
  {
    key: "muse-ember",
    label: "Muse Ember",
    vendor: "meta",
    pattern: /^meta\/muse-ember(?:-(\d+(?:\.\d+)*))?$/,
    images: true,
    reasoningMayBeRequired: true,
    efforts: EFFORTS,
  },
] as const satisfies readonly ModelLine[];

export type LineKey = (typeof MODEL_LINES)[number]["key"];

export const LINE_KEYS = MODEL_LINES.map((line) => line.key) as [LineKey, ...LineKey[]];
export const LineKeySchema = z.enum(LINE_KEYS);

/** The line a key names. Total over `LineKey`, so a caller never handles a missing line. */
export function lineByKey(key: LineKey): ModelLine {
  const line = MODEL_LINES.find((candidate) => candidate.key === key);
  // Unreachable: `LineKey` is derived from this very list.
  if (line === undefined) throw new Error(`no model line ${key}`);
  return line;
}

/** The line an exact OpenRouter id belongs to, or undefined for an id no line claims. */
export function lineOf(model: string): ModelLine | undefined {
  return MODEL_LINES.find((line) => line.pattern.test(model));
}

/**
 * One entry of OpenRouter's `GET /api/v1/models`, the fields the shape check reads and nothing
 * more. Prices are strings of US dollars per token, as OpenRouter sends them.
 */
export const CatalogModelSchema = z.object({
  id: z.string().min(1),
  /** Unix seconds. */
  created: z.number(),
  context_length: z.number().nullable(),
  architecture: z.object({ input_modalities: z.array(z.string()) }),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
  }),
  supported_parameters: z.array(z.string()),
  top_provider: z.object({ max_completion_tokens: z.number().nullable().optional() }),
  expiration_date: z.string().nullable().optional(),
  reasoning: z
    .object({
      mandatory: z.boolean().optional(),
      supported_efforts: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
});
export type CatalogModel = z.infer<typeof CatalogModelSchema>;

/**
 * The entries of a catalog response that parse, and the ids of those that did not.
 *
 * One entry at a time rather than the array whole: one malformed model among three hundred is
 * OpenRouter's problem with that model, and must not cost every line its version. The ids of the
 * ones that did not parse are kept, because a version listed in a shape nothing can check is not
 * the same as a version the catalog left out: the first cannot be vouched for.
 */
export function parseCatalog(body: unknown): { models: CatalogModel[]; unreadable: string[] } {
  const data = z.object({ data: z.array(z.unknown()) }).safeParse(body);
  if (!data.success) return { models: [], unreadable: [] };
  const models: CatalogModel[] = [];
  const unreadable: string[] = [];
  for (const entry of data.data.data) {
    const parsed = CatalogModelSchema.safeParse(entry);
    if (parsed.success) models.push(parsed.data);
    else {
      const id = z.object({ id: z.string() }).safeParse(entry);
      unreadable.push(id.success ? id.data.id : "(no id)");
    }
  }
  return { models, unreadable };
}

/** OpenRouter's public catalog. No key: it lists the same models for everybody. */
export const CATALOG_URL = "https://openrouter.ai/api/v1/models";

/** The output ceiling a turn asks for; a version that cannot write this much is skipped. */
export const MIN_OUTPUT_TOKENS = 64_000;

/** A version due to be withdrawn within this long is skipped, so nobody is moved onto it. */
export const EXPIRY_MARGIN_MS = 14 * 24 * 60 * 60 * 1_000;

export type ShapeCheckOptions = {
  now: Date;
  /** The smallest context window a turn fits in: the context budget plus the output ceiling. */
  minContextTokens: number;
  /**
   * How long before its expiry a version stops passing. `EXPIRY_MARGIN_MS` when choosing a version
   * to move onto; zero when asking whether the version a line is already on still works, which it
   * does until the day it is withdrawn.
   */
  expiryMarginMs?: number;
};

/**
 * Why a version cannot serve its line, or nothing when it can.
 *
 * Each reason names what failed, so the log line a skipped version produces says what to look at.
 */
export function shapeProblems(
  line: ModelLine,
  model: CatalogModel,
  options: ShapeCheckOptions,
): string[] {
  const problems: string[] = [];
  const params = model.supported_parameters;
  if (!params.includes("tools")) problems.push("no tool calling");
  if (!params.includes("reasoning")) problems.push("no reasoning");
  if (line.images && !model.architecture.input_modalities.includes("image"))
    problems.push("no image input");
  if (model.context_length === null || model.context_length < options.minContextTokens)
    problems.push(`context ${model.context_length ?? "unknown"} < ${options.minContextTokens}`);
  const maxOutput = model.top_provider.max_completion_tokens;
  if (maxOutput !== null && maxOutput !== undefined && maxOutput < MIN_OUTPUT_TOKENS)
    problems.push(`max output ${maxOutput} < ${MIN_OUTPUT_TOKENS}`);
  if (model.expiration_date !== null && model.expiration_date !== undefined) {
    const expires = Date.parse(model.expiration_date);
    const margin = options.expiryMarginMs ?? EXPIRY_MARGIN_MS;
    if (Number.isNaN(expires) || expires - options.now.getTime() < margin)
      problems.push(`expires ${model.expiration_date}`);
  }
  const efforts = model.reasoning?.supported_efforts ?? [];
  const missing = line.efforts.filter((effort) => !efforts.includes(effort));
  if (missing.length > 0) problems.push(`no effort ${missing.join("/")}`);
  if (model.reasoning?.mandatory === true && !line.reasoningMayBeRequired)
    problems.push("requires reasoning");
  problems.push(...priceProblems(model));
  return problems;
}

/**
 * A version priced, relative to its own input, above what the turn budget charges for it.
 *
 * The budget counts tokens by `billedWeightsFor`, so a version whose output or cache costs more
 * per input dollar than those weights say would let a turn spend past the ceiling it was given.
 */
function priceProblems(model: CatalogModel): string[] {
  const input = Number(model.pricing.prompt);
  if (!(input > 0)) return ["no input price"];
  const weights = billedWeightsFor(model.id);
  const ratios = [
    ["output", model.pricing.completion, weights.output],
    ["cache read", model.pricing.input_cache_read, weights.cacheRead],
    ["cache write", model.pricing.input_cache_write, weights.cacheWrite],
  ] as const;
  const problems: string[] = [];
  for (const [name, price, weight] of ratios) {
    if (price === undefined) continue;
    const ratio = Number(price) / input;
    // A tiny tolerance: prices are decimal strings and the ratio is float division.
    if (!Number.isFinite(ratio) || ratio > weight + 1e-9)
      problems.push(`${name} costs ${ratio.toFixed(3)}x input, over ${weight}x`);
  }
  return problems;
}

function versionOf(line: ModelLine, id: string): number[] | undefined {
  const match = line.pattern.exec(id);
  if (match === null) return undefined;
  const version = match[1];
  // No number counts as the oldest.
  return version === undefined ? [Number.NEGATIVE_INFINITY] : version.split(".").map(Number);
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export type LineResolution = {
  line: LineKey;
  /** The exact id a turn on this line runs on, or null when no version passes. */
  model: string | null;
  /** Unix seconds the chosen version was listed, when the catalog said. */
  created: number | null;
  /** True when `NAP_MODEL_PINS` named the version rather than the catalog choosing it. */
  pinned: boolean;
  /** Newer versions passed over, and why: what a log line about this line says. */
  skipped: { model: string; problems: string[] }[];
};

export type ResolveOptions = ShapeCheckOptions & {
  /** A version per line that wins over whatever the catalog says. */
  pins?: Partial<Record<LineKey, string>>;
};

/** The version one line runs on, from one catalog. */
export function resolveLine(
  line: ModelLine & { key: LineKey },
  catalog: readonly CatalogModel[],
  options: ResolveOptions,
): LineResolution {
  const pin = options.pins?.[line.key];
  if (pin !== undefined) {
    const listed = catalog.find((model) => model.id === pin);
    return {
      line: line.key,
      model: pin,
      created: listed?.created ?? null,
      pinned: true,
      skipped: [],
    };
  }

  const members = catalog
    .map((model) => ({ model, version: versionOf(line, model.id) }))
    .filter(
      (member): member is { model: CatalogModel; version: number[] } =>
        member.version !== undefined,
    )
    .sort((a, b) => compareVersions(b.version, a.version) || b.model.created - a.model.created);

  const skipped: LineResolution["skipped"] = [];
  for (const { model } of members) {
    const problems = shapeProblems(line, model, options);
    if (problems.length === 0)
      return { line: line.key, model: model.id, created: model.created, pinned: false, skipped };
    skipped.push({ model: model.id, problems });
  }
  return { line: line.key, model: null, created: null, pinned: false, skipped };
}

/** Every line's version, from one catalog. */
export function resolveLines(
  catalog: readonly CatalogModel[],
  options: ResolveOptions,
): Record<LineKey, LineResolution> {
  return Object.fromEntries(
    MODEL_LINES.map((line) => [line.key, resolveLine(line, catalog, options)]),
  ) as Record<LineKey, LineResolution>;
}

/** The vendors lines are drawn from, as OpenRouter namespaces them. */
const LINE_VENDORS: readonly ModelVendor[] = ["openai", "anthropic", "meta"];

/**
 * The families a catalog lists from the lines' vendors that no line claims: what a log line
 * reports, so somebody hears that OpenAI shipped a new family rather than finding out from a
 * customer.
 *
 * A family is an id with its version numbers taken out (`openai/gpt-*-terra`), so a new version of
 * an unclaimed family is not reported again. Routes and variants that are never lines — batch, free,
 * `-pro`, `-contributor` — are left out, or every refresh would report them.
 */
export function unclaimedFamilies(catalog: readonly CatalogModel[]): string[] {
  const families = new Set<string>();
  for (const { id } of catalog) {
    const vendor = id.split("/")[0] ?? "";
    if (!(LINE_VENDORS as readonly string[]).includes(vendor)) continue;
    if (/:|-pro$|-contributor$/.test(id)) continue;
    if (lineOf(id) !== undefined) continue;
    families.add(id.replace(/\d+(?:\.\d+)*/g, "*"));
  }
  return [...families].sort();
}
