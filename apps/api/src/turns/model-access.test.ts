import type { Effort, LineKey } from "@nap/shared/model-lines";
import { describe, expect, it } from "vitest";
import {
  type CallerKey,
  defaultLine,
  type ModelPolicy,
  refusalStatus,
  resolveTitleAccess,
  resolveTurnAccess,
} from "./model-access.ts";

const OPENROUTER: CallerKey = { platform: "openrouter", apiKey: "sk-or-x" };
const ANTHROPIC: CallerKey = { platform: "anthropic", apiKey: "sk-ant-x" };
const FREE = "nvidia/nemotron-3.5-super-vl:free";

const VERSIONS: Partial<Record<LineKey, string>> = {
  sol: "openai/gpt-6.2-sol",
  luna: "openai/gpt-6-luna",
  opus: "anthropic/claude-opus-5.5",
  haiku: "anthropic/claude-haiku-5.5",
  "muse-ember": "meta/muse-ember",
  // Fable has no working version in this catalog.
};

function policy(
  freeModel: string | undefined = undefined,
  freeEffort: Effort = "low",
): ModelPolicy {
  return { versionOf: (line) => VERSIONS[line] ?? null, freeModel, freeEffort };
}

type Row = {
  name: string;
  key: CallerKey;
  free?: string;
  requested?: string;
  effort?: Effort;
  expected:
    | { model: string; effort: Effort; pays: "caller" | "deployment" }
    | { refused: "byok_required" | "model_not_allowed" | "model_unavailable" };
};

// The whole policy, one row per combination that decides money: who asked, with what key, for
// what, on a deployment with or without a free tier.
const ROWS: Row[] = [
  // No key, no free tier: nothing, whatever is asked for.
  {
    name: "no key, no free tier, nothing named",
    key: null,
    expected: { refused: "byok_required" },
  },
  {
    name: "no key, no free tier, a line",
    key: null,
    requested: "sol",
    expected: { refused: "byok_required" },
  },
  {
    name: "no key, no free tier, a free model",
    key: null,
    requested: FREE,
    expected: { refused: "byok_required" },
  },
  // No key, a free tier: that model, at the deployment's effort, on the deployment's account.
  {
    name: "no key, free tier, nothing named",
    key: null,
    free: FREE,
    effort: "max",
    expected: { model: FREE, effort: "low", pays: "deployment" },
  },
  {
    name: "no key, free tier, the free model named",
    key: null,
    free: FREE,
    requested: FREE,
    expected: { model: FREE, effort: "low", pays: "deployment" },
  },
  {
    name: "no key, a line version as the free model, named exactly",
    key: null,
    free: "openai/gpt-6-luna",
    requested: "openai/gpt-6-luna",
    expected: { model: "openai/gpt-6-luna", effort: "low", pays: "deployment" },
  },
  {
    name: "no key, free tier, a line",
    key: null,
    free: FREE,
    requested: "opus",
    expected: { refused: "byok_required" },
  },
  {
    name: "no key, free tier, a model that is no line",
    key: null,
    free: FREE,
    requested: "openai/gpt-5.6-terra",
    expected: { refused: "model_not_allowed" },
  },
  // An OpenRouter key: every line, on the caller's account, Sol by default.
  {
    name: "OpenRouter key, nothing named",
    key: OPENROUTER,
    expected: { model: "openai/gpt-6.2-sol", effort: "medium", pays: "caller" },
  },
  {
    name: "OpenRouter key, a Claude line at max",
    key: OPENROUTER,
    requested: "opus",
    effort: "max",
    expected: { model: "anthropic/claude-opus-5.5", effort: "max", pays: "caller" },
  },
  {
    name: "OpenRouter key, a Meta line",
    key: OPENROUTER,
    requested: "muse-ember",
    expected: { model: "meta/muse-ember", effort: "medium", pays: "caller" },
  },
  {
    name: "OpenRouter key, an old exact version a saved draft held",
    key: OPENROUTER,
    requested: "openai/gpt-5.6-sol",
    expected: { model: "openai/gpt-6.2-sol", effort: "medium", pays: "caller" },
  },
  {
    name: "OpenRouter key, the free model is not a line",
    key: OPENROUTER,
    free: FREE,
    requested: FREE,
    expected: { refused: "model_not_allowed" },
  },
  {
    name: "OpenRouter key, a line with no working version",
    key: OPENROUTER,
    requested: "fable",
    expected: { refused: "model_unavailable" },
  },
  {
    name: "OpenRouter key, a typo",
    key: OPENROUTER,
    requested: "sool",
    expected: { refused: "model_not_allowed" },
  },
  // An Anthropic key: the Claude lines only, Opus by default.
  {
    name: "Anthropic key, nothing named",
    key: ANTHROPIC,
    expected: { model: "anthropic/claude-opus-5.5", effort: "medium", pays: "caller" },
  },
  {
    name: "Anthropic key, Haiku",
    key: ANTHROPIC,
    requested: "haiku",
    effort: "xhigh",
    expected: { model: "anthropic/claude-haiku-5.5", effort: "xhigh", pays: "caller" },
  },
  {
    name: "Anthropic key, an OpenAI line",
    key: ANTHROPIC,
    requested: "sol",
    expected: { refused: "model_not_allowed" },
  },
  {
    name: "Anthropic key, a Meta line",
    key: ANTHROPIC,
    requested: "muse-ember",
    expected: { refused: "model_not_allowed" },
  },
  // A free tier changes nothing for somebody with a key.
  {
    name: "OpenRouter key on a deployment with a free tier, nothing named",
    key: OPENROUTER,
    free: FREE,
    expected: { model: "openai/gpt-6.2-sol", effort: "medium", pays: "caller" },
  },
];

describe("who may run what, at what effort, and who pays", () => {
  it.each(ROWS)("$name", ({ key, free, requested, effort, expected }) => {
    const access = resolveTurnAccess({ requested, effort, key, policy: policy(free) });
    if ("refused" in expected) {
      expect(access).toMatchObject({ ok: false, code: expected.refused });
      return;
    }
    expect(access).toMatchObject({ ok: true, model: expected.model, effort: expected.effort });
    // The money question, asked directly: a turn the caller pays for carries their key.
    expect(access.ok && access.credentials).toEqual(expected.pays === "caller" ? key : undefined);
  });

  it("answers each refusal with the status the browser reads", () => {
    expect(refusalStatus("byok_required")).toBe(403);
    expect(refusalStatus("model_not_allowed")).toBe(400);
    expect(refusalStatus("model_unavailable")).toBe(409);
  });
});

describe("the default line", () => {
  it("is the key's own while it has a version, and the first reachable working line when not", () => {
    // What the picker shows as the default and what a turn naming nothing runs on are one rule.
    const noSol: ModelPolicy = {
      versionOf: (line) => (line === "sol" ? null : (VERSIONS[line] ?? null)),
      freeModel: undefined,
      freeEffort: "low",
    };
    expect(defaultLine("openrouter", policy())).toBe("sol");
    expect(defaultLine("openrouter", noSol)).toBe("luna");
    expect(
      resolveTurnAccess({ requested: undefined, key: OPENROUTER, policy: noSol }),
    ).toMatchObject({ ok: true, model: "openai/gpt-6-luna" });
    expect(defaultLine("anthropic", policy())).toBe("opus");
  });
});

describe("who pays for a title, and on which model", () => {
  it.each<[string, CallerKey, string | undefined, ReturnType<typeof resolveTitleAccess>]>([
    [
      "an OpenRouter key, on Luna",
      OPENROUTER,
      undefined,
      { model: "openai/gpt-6-luna", credentials: OPENROUTER as never },
    ],
    [
      "an Anthropic key, on Haiku",
      ANTHROPIC,
      undefined,
      { model: "anthropic/claude-haiku-5.5", credentials: ANTHROPIC as never },
    ],
    ["no key on a free tier, on the free model", null, FREE, { model: FREE }],
    ["no key and no free tier, nobody", null, undefined, null],
  ])("%s", (_, key, free, expected) => {
    expect(resolveTitleAccess({ key, policy: policy(free) })).toEqual(expected);
  });

  it("writes no title when the title line has no working version", () => {
    const empty: ModelPolicy = { versionOf: () => null, freeModel: undefined, freeEffort: "low" };
    expect(resolveTitleAccess({ key: OPENROUTER, policy: empty })).toBeNull();
  });
});
