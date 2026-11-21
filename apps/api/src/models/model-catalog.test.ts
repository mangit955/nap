import type { Logger } from "@nap/shared/logging";
import { SNAPSHOT_CATALOG } from "@nap/shared/model-catalog-snapshot";
import { type CatalogModel, EFFORTS } from "@nap/shared/model-lines";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOG_REFRESH_MS, ModelCatalog, startCatalogRefresh } from "./model-catalog.ts";

const NOW = new Date("2026-11-20T00:00:00Z");

function entry(id: string, overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    created: Math.floor(NOW.getTime() / 1_000) - 30 * 24 * 60 * 60,
    context_length: 1_000_000,
    architecture: { input_modalities: ["text", "image"] },
    pricing: { prompt: "0.000002", completion: "0.00001" },
    supported_parameters: ["tools", "reasoning"],
    top_provider: { max_completion_tokens: 128_000 },
    expiration_date: null,
    reasoning: { mandatory: false, supported_efforts: [...EFFORTS] },
    ...overrides,
  };
}

function recorder() {
  const lines: { level: string; fields: object; message: string }[] = [];
  const at =
    (level: string) =>
    (fieldsOrMessage: object | string, message?: string): void => {
      if (typeof fieldsOrMessage === "string")
        lines.push({ level, fields: {}, message: fieldsOrMessage });
      else lines.push({ level, fields: fieldsOrMessage, message: message ?? "" });
    };
  const logger: Logger = {
    child: () => logger,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
  return { logger, lines };
}

const BASE = [
  entry("openai/gpt-6.1-sol"),
  entry("anthropic/claude-opus-5"),
  entry("openai/gpt-6-luna"),
];

function catalog(snapshot: readonly CatalogModel[] = BASE, pins = {}) {
  const log = recorder();
  const models = new ModelCatalog({
    snapshot,
    pins,
    minContextTokens: 144_000,
    now: () => NOW,
    logger: log.logger,
  });
  return { models, log };
}

const answer = (models: CatalogModel[]) => async () => ({ data: models });

describe("the model catalog", () => {
  it("answers from the committed snapshot before it has refreshed at all", () => {
    const { models } = catalog(SNAPSHOT_CATALOG);
    expect(models.versionOf("sol")).toBe("openai/gpt-6.2-sol");
    expect(models.versionOf("opus")).toBe("anthropic/claude-opus-5.5");
  });

  it("moves a line onto a newer version, and says so", async () => {
    const { models, log } = catalog();
    expect(await models.refresh(answer([...BASE, entry("openai/gpt-6.3-sol")]))).toBe(true);
    expect(models.versionOf("sol")).toBe("openai/gpt-6.3-sol");
    expect(log.lines).toContainEqual(
      expect.objectContaining({
        message: "model line moved to a new version",
        fields: expect.objectContaining({
          line: "sol",
          from: "openai/gpt-6.1-sol",
          to: "openai/gpt-6.3-sol",
        }),
      }),
    );
  });

  it.each([
    ["a fetch that fails", async () => Promise.reject(new Error("offline"))],
    ["a body that is not a catalog", async () => ({ error: "nope" })],
    ["a catalog listing nothing", async () => ({ data: [] })],
  ])("keeps the last good copy after %s", async (_, fetchCatalog) => {
    const { models, log } = catalog();
    await models.refresh(answer([...BASE, entry("openai/gpt-6.3-sol")]));
    expect(await models.refresh(fetchCatalog)).toBe(false);
    expect(models.versionOf("sol")).toBe("openai/gpt-6.3-sol");
    expect(log.lines.at(-1)?.level).toBe("warn");
  });

  it("keeps a line's last good version when the new catalog has nothing usable for it", async () => {
    const { models, log } = catalog();
    // Sol's only listing now has no tool calling: a version no turn could run on.
    await models.refresh(
      answer([
        entry("openai/gpt-6.3-sol", { supported_parameters: ["reasoning"] }),
        entry("anthropic/claude-opus-5"),
      ]),
    );
    expect(models.versionOf("sol")).toBe("openai/gpt-6.1-sol");
    expect(log.lines).toContainEqual(
      expect.objectContaining({
        level: "warn",
        fields: expect.objectContaining({
          line: "sol",
          staying: "openai/gpt-6.1-sol",
          skipped: [{ model: "openai/gpt-6.3-sol", problems: ["no tool calling"] }],
        }),
      }),
    );
  });

  it.each([
    ["it has been withdrawn", { expiration_date: "2026-11-19" }],
    [
      "it now costs more than the budget charges",
      { pricing: { prompt: "0.000001", completion: "0.00001" } },
    ],
  ])("leaves a line with nothing when its own version fails because %s", async (_, spoil) => {
    // Keeping the last good version is for a version the catalog left out; one it lists and
    // the check refuses is not good any more, and running on it would be the check bypassed.
    const { models, log } = catalog();
    await models.refresh(
      answer([entry("openai/gpt-6.1-sol", spoil), entry("anthropic/claude-opus-5")]),
    );
    expect(models.versionOf("sol")).toBeNull();
    expect(log.lines).toContainEqual(
      expect.objectContaining({
        level: "warn",
        fields: expect.objectContaining({ line: "sol", from: "openai/gpt-6.1-sol" }),
      }),
    );
  });

  it("leaves a line with nothing when its own version is listed in a shape that cannot be checked", async () => {
    // A completion price sent as a number does not parse; the version is listed, not left out,
    // and nothing can say it is still within the budget's weights.
    const { models } = catalog();
    const unreadable = {
      ...entry("openai/gpt-6.1-sol"),
      pricing: { prompt: "0.000001", completion: 0.00001 },
    };
    await models.refresh(async () => ({ data: [unreadable, entry("anthropic/claude-opus-5")] }));
    expect(models.versionOf("sol")).toBeNull();
  });

  it("drops a version past the expiry an earlier catalog announced, when a later one leaves it out", async () => {
    // Announced as withdrawn on the 21st, then simply missing from the catalog after that date:
    // not a partial answer to wait out, but the version that was said to go, gone.
    let now = new Date("2026-11-20T00:00:00Z");
    const log = recorder();
    const models = new ModelCatalog({
      snapshot: BASE,
      pins: {},
      minContextTokens: 144_000,
      now: () => now,
      logger: log.logger,
    });
    await models.refresh(
      answer([
        entry("openai/gpt-6.1-sol", { expiration_date: "2026-11-21" }),
        entry("anthropic/claude-opus-5"),
      ]),
    );
    expect(models.versionOf("sol")).toBe("openai/gpt-6.1-sol");
    now = new Date("2026-11-22T00:00:00Z");
    await models.refresh(answer([entry("anthropic/claude-opus-5")]));
    expect(models.versionOf("sol")).toBeNull();
  });

  it("stays on a version that expires soon until it actually does", async () => {
    // The fortnight's margin keeps a line from moving onto a version about to go; applied to the
    // one it is on, it would refuse every turn on a line whose model still answers.
    const { models } = catalog();
    await models.refresh(
      answer([
        entry("openai/gpt-6.1-sol", { expiration_date: "2026-12-01" }),
        entry("anthropic/claude-opus-5"),
      ]),
    );
    expect(models.versionOf("sol")).toBe("openai/gpt-6.1-sol");
  });

  it("lists unclaimed families once as a baseline, then reports only a new one", async () => {
    // From a snapshot with no unclaimed family in it, as the committed one is: the first refresh
    // must not call every family OpenRouter has new on every boot.
    const { models, log } = catalog();
    const terra = entry("openai/gpt-6-terra");
    await models.refresh(answer([...BASE, terra]));
    await models.refresh(answer([...BASE, terra, entry("openai/gpt-6.1-terra")]));
    await models.refresh(answer([...BASE, terra, entry("openai/gpt-7-nova")]));
    const reports = log.lines.filter((line) => line.message.includes("no line claims"));
    expect(reports.map((report) => [report.message, report.fields])).toEqual([
      ["the model catalog lists families no line claims", { families: ["openai/gpt-*-terra"] }],
      ["the model catalog lists a new family no line claims", { families: ["openai/gpt-*-nova"] }],
    ]);
  });

  it("runs a pinned line on its pin whatever the catalog lists", async () => {
    const { models } = catalog(BASE, { sol: "openai/gpt-6-sol" });
    await models.refresh(answer([...BASE, entry("openai/gpt-7-sol")]));
    expect(models.versionOf("sol")).toBe("openai/gpt-6-sol");
  });

  it("still runs a pin the shape check refuses, and says why", async () => {
    const { models, log } = catalog(BASE, { luna: "openai/gpt-6-luna" });
    const mandatory = { reasoning: { mandatory: true, supported_efforts: [...EFFORTS] } };
    await models.refresh(
      answer([entry("openai/gpt-6-luna", mandatory), entry("openai/gpt-6.1-sol")]),
    );
    expect(models.versionOf("luna")).toBe("openai/gpt-6-luna");
    expect(log.lines).toContainEqual(
      expect.objectContaining({
        level: "warn",
        fields: { line: "luna", pinned: "openai/gpt-6-luna", problems: ["requires reasoning"] },
      }),
    );
  });

  it("calls a version new for two weeks after it was listed", () => {
    const fresh = Math.floor(NOW.getTime() / 1_000) - 3 * 24 * 60 * 60;
    const { models } = catalog([entry("openai/gpt-6.3-sol", { created: fresh }), ...BASE]);
    expect(models.isNew("sol")).toBe(true);
    expect(models.isNew("opus")).toBe(false);
    expect(models.isNew("fable")).toBe(false);
  });
});

describe("refreshing on a timer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("refreshes at once, then hourly", async () => {
    const { models } = catalog();
    const fetchCatalog = vi.fn(answer([...BASE, entry("openai/gpt-6.3-sol")]));
    const schedule = startCatalogRefresh({ catalog: models, fetchCatalog });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    expect(models.versionOf("sol")).toBe("openai/gpt-6.3-sol");

    await vi.advanceTimersByTimeAsync(CATALOG_REFRESH_MS - 1);
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchCatalog).toHaveBeenCalledTimes(2);

    schedule.stop();
    await vi.advanceTimersByTimeAsync(CATALOG_REFRESH_MS * 3);
    expect(fetchCatalog).toHaveBeenCalledTimes(2);
  });
});
