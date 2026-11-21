import { describe, expect, it } from "vitest";
import { SNAPSHOT_CATALOG } from "./model-catalog-snapshot.ts";
import {
  type CatalogModel,
  EFFORTS,
  LINE_KEYS,
  lineByKey,
  lineOf,
  parseCatalog,
  resolveLine,
  resolveLines,
  shapeProblems,
  unclaimedFamilies,
} from "./model-lines.ts";

const NOW = new Date("2026-11-20T00:00:00Z");
const OPTIONS = { now: NOW, minContextTokens: 144_000 };

/** A version that passes every check; each test spoils one thing about it. */
function model(id: string, overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    created: 1_790_000_000,
    context_length: 1_000_000,
    architecture: { input_modalities: ["text", "image"] },
    pricing: {
      prompt: "0.000002",
      completion: "0.00001",
      input_cache_read: "0.0000002",
      input_cache_write: "0.0000025",
    },
    supported_parameters: ["tools", "reasoning"],
    top_provider: { max_completion_tokens: 128_000 },
    expiration_date: null,
    reasoning: { mandatory: false, supported_efforts: [...EFFORTS] },
    ...overrides,
  };
}

const sol = lineByKey("sol") as ReturnType<typeof lineByKey> & { key: "sol" };
const luna = lineByKey("luna") as ReturnType<typeof lineByKey> & { key: "luna" };
const ember = lineByKey("muse-ember") as ReturnType<typeof lineByKey> & { key: "muse-ember" };

describe("which version a line runs on", () => {
  it("takes the highest version number, not the newest listing", () => {
    const catalog = [
      model("openai/gpt-6.1-sol", { created: 3 }),
      model("openai/gpt-6.10-sol", { created: 1 }),
      model("openai/gpt-6.2-sol", { created: 2 }),
      model("openai/gpt-6-sol", { created: 4 }),
    ];
    expect(resolveLine(sol, catalog, OPTIONS).model).toBe("openai/gpt-6.10-sol");
  });

  it("counts an id with no number as the oldest, and breaks a tie by the newer listing", () => {
    expect(
      resolveLine(ember, [model("meta/muse-ember"), model("meta/muse-ember-2")], OPTIONS).model,
    ).toBe("meta/muse-ember-2");
    // `6` and `6.0` are the same version; the later listing wins.
    expect(
      resolveLine(
        sol,
        [model("openai/gpt-6-sol", { created: 1 }), model("openai/gpt-6.0-sol", { created: 2 })],
        OPTIONS,
      ).model,
    ).toBe("openai/gpt-6.0-sol");
  });

  it("never picks a batch route, a -pro variant or a contributor build", () => {
    const catalog = [
      model("openai/gpt-6-sol"),
      model("openai/gpt-7-sol:batch"),
      model("openai/gpt-7-sol-pro"),
      model("openai/gpt-7-sol-contributor"),
    ];
    expect(resolveLine(sol, catalog, OPTIONS).model).toBe("openai/gpt-6-sol");
    expect(lineOf("openai/gpt-7-sol-pro")).toBeUndefined();
  });

  it("is empty when no version passes, naming why each was skipped", () => {
    const resolution = resolveLine(
      sol,
      [model("openai/gpt-6-sol", { supported_parameters: ["reasoning"] })],
      OPTIONS,
    );
    expect(resolution.model).toBeNull();
    expect(resolution.skipped).toEqual([
      { model: "openai/gpt-6-sol", problems: ["no tool calling"] },
    ]);
  });

  it("runs a pinned version whatever the catalog says", () => {
    const resolution = resolveLine(sol, [model("openai/gpt-6.2-sol")], {
      ...OPTIONS,
      pins: { sol: "openai/gpt-6-sol" },
    });
    expect(resolution).toMatchObject({ model: "openai/gpt-6-sol", pinned: true });
  });
});

describe("the shape check", () => {
  // One row per guard: the newest version is spoiled one way, and the line must fall back to the
  // version below it rather than run on it.
  it.each<[string, Partial<CatalogModel>, string]>([
    ["no tools", { supported_parameters: ["reasoning"] }, "no tool calling"],
    ["no reasoning", { supported_parameters: ["tools"] }, "no reasoning"],
    ["no images", { architecture: { input_modalities: ["text"] } }, "no image input"],
    ["a small context", { context_length: 128_000 }, "context 128000 < 144000"],
    ["a short output", { top_provider: { max_completion_tokens: 32_000 } }, "max output 32000"],
    ["expiring soon", { expiration_date: "2026-11-30" }, "expires 2026-11-30"],
    [
      "no max effort",
      { reasoning: { supported_efforts: ["low", "medium", "high", "xhigh"] } },
      "no effort max",
    ],
    [
      "output above the weights",
      { pricing: { prompt: "0.000001", completion: "0.000007" } },
      "output costs 7.000x input, over 6x",
    ],
    [
      "a cache read above the weights",
      { pricing: { prompt: "0.000001", completion: "0.000005", input_cache_read: "0.0000005" } },
      "cache read costs 0.500x input",
    ],
    ["no input price", { pricing: { prompt: "0", completion: "0" } }, "no input price"],
  ])("skips a version with %s", (_, spoil, problem) => {
    const catalog = [model("openai/gpt-6.2-sol", spoil), model("openai/gpt-6.1-sol")];
    const resolution = resolveLine(sol, catalog, OPTIONS);
    expect(resolution.model).toBe("openai/gpt-6.1-sol");
    expect(resolution.skipped[0]?.problems.join("; ")).toContain(problem);
  });

  it("lets a version require reasoning only on a line allowed to", () => {
    const mandatory = { reasoning: { mandatory: true, supported_efforts: [...EFFORTS] } };
    // Sol is not where titles are written, so a version that insists on reasoning is fine there.
    expect(shapeProblems(sol, model("openai/gpt-6.2-sol", mandatory), OPTIONS)).toEqual([]);
    // Luna is, and a title is asked for with reasoning off.
    const catalog = [model("openai/gpt-7-luna", mandatory), model("openai/gpt-6-luna")];
    const resolution = resolveLine(luna, catalog, OPTIONS);
    expect(resolution.model).toBe("openai/gpt-6-luna");
    expect(resolution.skipped[0]?.problems).toEqual(["requires reasoning"]);
  });

  it("accepts an unknown output ceiling, and an expiry far enough away", () => {
    const fine = model("openai/gpt-6-sol", {
      top_provider: { max_completion_tokens: null },
      expiration_date: "2027-06-01",
    });
    expect(shapeProblems(sol, fine, OPTIONS)).toEqual([]);
  });
});

describe("the catalog", () => {
  it("keeps every entry that parses when one does not", () => {
    const parsed = parseCatalog({ data: [model("openai/gpt-6-sol"), { id: "broken" }] });
    expect(parsed.models.map((entry) => entry.id)).toEqual(["openai/gpt-6-sol"]);
    expect(parsed.unreadable).toEqual(["broken"]);
  });

  it("reads a body that is not a catalog as an empty one", () => {
    expect(parseCatalog({ error: "nope" })).toEqual({ models: [], unreadable: [] });
  });

  it("reports the families no line claims, once each, and not the variants", () => {
    const catalog = [
      model("openai/gpt-6-terra"),
      model("openai/gpt-6.2-terra"),
      model("openai/gpt-6.2-sol"),
      model("openai/gpt-6.2-sol-pro"),
      model("openai/gpt-oss-20b:free"),
      model("google/gemini-4-neon"),
    ];
    expect(unclaimedFamilies(catalog)).toEqual(["openai/gpt-*-terra"]);
  });

  it("starts every line on a version from the committed snapshot", () => {
    const resolved = resolveLines(SNAPSHOT_CATALOG, OPTIONS);
    for (const key of LINE_KEYS) expect(resolved[key].model, key).not.toBeNull();
  });
});
