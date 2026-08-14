import type { ModelCredentials } from "@nap/shared/ports/llm-provider";
import { describe, expect, it } from "vitest";
import {
  availableModels,
  isFree,
  resolveTurnAccess,
  type TurnAccessRequest,
} from "./model-access.ts";

/** The shape of a real allowlist: cheap paid, expensive paid, and free. */
const ALLOWED = [
  "openai/gpt-5.6-luna",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-5",
  "openai/gpt-oss-20b:free",
] as const;

const OPENROUTER: ModelCredentials = { platform: "openrouter", apiKey: "sk-or-theirs" };
const ANTHROPIC: ModelCredentials = { platform: "anthropic", apiKey: "sk-ant-theirs" };

function ask(overrides: Partial<TurnAccessRequest> = {}): TurnAccessRequest {
  return {
    requested: undefined,
    key: null,
    allowed: ALLOWED,
    freeModel: "openai/gpt-5.6-luna",
    defaultModel: "openai/gpt-5.6-luna",
    ...overrides,
  };
}

describe("isFree", () => {
  it("reads OpenRouter's convention and nothing else", () => {
    expect(isFree("openai/gpt-oss-20b:free")).toBe(true);
    expect(isFree("anthropic/claude-opus-5")).toBe(false);
    // Not a suffix, so not free. A substring match here would make ":free-tier-preview" free.
    expect(isFree("vendor/free-model")).toBe(false);
  });
});

describe("with no key of their own", () => {
  it("runs the free model when nothing is named", () => {
    expect(resolveTurnAccess(ask())).toEqual({ ok: true, model: "openai/gpt-5.6-luna" });
  });

  it("never attaches credentials, so the deployment's own account pays", () => {
    const access = resolveTurnAccess(ask());

    expect(access.ok === true && access.credentials).toBeUndefined();
  });

  it("allows a free model that was named explicitly", () => {
    expect(resolveTurnAccess(ask({ requested: "openai/gpt-oss-20b:free" }))).toEqual({
      ok: true,
      model: "openai/gpt-oss-20b:free",
    });
  });

  it("allows the deployment's free model even though it is not :free-suffixed", () => {
    // The freeModel is what the deployment chose to give demo visitors. That choice is not
    // always a :free-suffixed model — here it is Luna, which the deployment pays for.
    expect(resolveTurnAccess(ask({ requested: "openai/gpt-5.6-luna" }))).toEqual({
      ok: true,
      model: "openai/gpt-5.6-luna",
    });
  });

  it("refuses a paid model that is not the deployment's chosen free model", () => {
    // The rule this whole module exists for. Each of these is on the allowlist, so nothing
    // else in the request pipeline would stop it.
    for (const model of ["anthropic/claude-opus-5"]) {
      expect(resolveTurnAccess(ask({ requested: model }))).toMatchObject({
        ok: false,
        code: "byok_required",
      });
    }
  });

  it("says a model is unknown rather than asking for a key, when it is unknown", () => {
    // A typo must not send somebody off to fetch a credential that would not have helped.
    expect(resolveTurnAccess(ask({ requested: "openai/not-a-model" }))).toMatchObject({
      code: "model_not_allowed",
    });
  });
});

describe("with an OpenRouter key", () => {
  it("runs the deployment's default when nothing is named", () => {
    expect(resolveTurnAccess(ask({ key: OPENROUTER }))).toEqual({
      ok: true,
      model: "openai/gpt-5.6-luna",
      credentials: OPENROUTER,
    });
  });

  it("reaches every model on the allowlist, billed to that key", () => {
    for (const model of ALLOWED) {
      expect(resolveTurnAccess(ask({ key: OPENROUTER, requested: model }))).toEqual({
        ok: true,
        model,
        credentials: OPENROUTER,
      });
    }
  });

  it("still refuses a model that is not on the allowlist", () => {
    // A key of their own is not permission to name arbitrary models: the allowlist is also
    // what keeps a turn on a model that cannot call tools, and every such turn fails.
    expect(resolveTurnAccess(ask({ key: OPENROUTER, requested: "vendor/anything" }))).toMatchObject(
      { code: "model_not_allowed" },
    );
  });
});

describe("with an Anthropic key", () => {
  it("runs a Claude model when nothing is named, not the OpenRouter-shaped default", () => {
    // `NAP_MODEL` is namespaced for OpenRouter and unreachable at Anthropic's own API, so
    // falling through to it would make "just send a message" fail for every Anthropic key.
    expect(resolveTurnAccess(ask({ key: ANTHROPIC }))).toEqual({
      ok: true,
      model: "anthropic/claude-sonnet-5",
      credentials: ANTHROPIC,
    });
  });

  it("reaches the Claude models", () => {
    expect(
      resolveTurnAccess(ask({ key: ANTHROPIC, requested: "anthropic/claude-opus-5" })),
    ).toEqual({ ok: true, model: "anthropic/claude-opus-5", credentials: ANTHROPIC });
  });

  it("refuses another vendor's model, naming the actual problem", () => {
    // Sent anyway, this is a 401 from Anthropic — a message about credentials for what is
    // really a routing mistake.
    const refusal = resolveTurnAccess(ask({ key: ANTHROPIC, requested: "openai/gpt-5.6-luna" }));

    expect(refusal).toMatchObject({ ok: false, code: "model_not_allowed" });
    expect(refusal.ok === false && refusal.message).toContain("Anthropic key");
  });

  it("refuses even a free model from another vendor", () => {
    expect(
      resolveTurnAccess(ask({ key: ANTHROPIC, requested: "openai/gpt-oss-20b:free" })),
    ).toMatchObject({ code: "model_not_allowed" });
  });
});

describe("availableModels", () => {
  const FREE_MODEL = "openai/gpt-5.6-luna";

  it("offers the freeModel and any :free-suffixed models to somebody with no key", () => {
    // The freeModel is always offered, regardless of suffix. Any additional :free-suffixed
    // models are offered too, since those cost the deployment nothing.
    expect(availableModels(ALLOWED, null, FREE_MODEL)).toEqual([
      "openai/gpt-5.6-luna",
      "openai/gpt-oss-20b:free",
    ]);
  });

  it("offers everything to an OpenRouter key", () => {
    expect(availableModels(ALLOWED, OPENROUTER)).toEqual([...ALLOWED]);
  });

  it("offers the Claude models to an Anthropic key", () => {
    expect(availableModels(ALLOWED, ANTHROPIC)).toEqual([
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-5",
    ]);
  });

  it("agrees with what resolveTurnAccess actually allows", () => {
    // The picker is built from the first and the turn is enforced by the second. Two lists
    // that drift produce a menu offering models every turn is then refused for naming, which
    // is the exact failure the models route's own comment warns about.
    for (const key of [null, OPENROUTER, ANTHROPIC]) {
      for (const model of ALLOWED) {
        const offered = availableModels(ALLOWED, key, FREE_MODEL).includes(model);
        const allowed = resolveTurnAccess(ask({ key, requested: model })).ok;
        expect(offered).toBe(allowed);
      }
    }
  });
});
