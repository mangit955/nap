/**
 * The judge's machinery, exercised without a model and without a network.
 *
 * What is tested here is everything between the port and the wire: the message that carries the
 * images, the tool the model is forced into, the conversion of an answer back into a judgement,
 * and — the part that matters most — what happens when the answer is wrong. None of it says
 * whether the judge *discriminates*; that question cannot be answered for free, and it is
 * answered in `corpus-discrimination.integration.test.ts` by watching a real one do it.
 */

import { PRODUCT_DIMENSIONS } from "@nap/bench/product/dimension";
import type { ProductEvaluationInput } from "@nap/bench/product/evaluation";
import { describe, expect, it } from "vitest";
import { CORPUS_ROOT } from "./corpus-fixtures.ts";
import {
  buildJudgeMessage,
  JUDGE_TOOL_NAME,
  type JudgeUsage,
  judgementFrom,
  judgeToolDefinition,
  type MessagesReply,
  OpenRouterVisionJudge,
  parseMessagesReply,
  toolInputOf,
  visionJudgeIdentity,
} from "./vision-judge.ts";

const INPUT: ProductEvaluationInput = {
  taskId: "fixture",
  runId: "run-1",
  intent: "A small team's task tracker.",
  screenshots: [
    { surfaceId: "home", viewport: "mobile", path: "home/mobile.png" },
    { surfaceId: "home", viewport: "desktop", path: "home/desktop.png" },
  ],
};

const JUDGE = visionJudgeIdentity("openai/some-model");

/** A well-formed answer, which each test then bends in one place. */
function answer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const graded = {
    status: "graded",
    grade: "good",
    evidence: [{ surface: "home", viewport: "desktop", observation: "one accent colour" }],
    strengths: ["consistent spacing steps"],
    weaknesses: [],
  };

  return {
    dimensions: Object.fromEntries(PRODUCT_DIMENSIONS.map((name) => [name, { ...graded }])),
    polish: { ...graded },
    ...overrides,
  };
}

describe("buildJudgeMessage", () => {
  it("labels every image before it, in the vocabulary evidence must come back in", () => {
    const content = buildJudgeMessage("A tracker.", [
      { screenshot: INPUT.screenshots[0]!, base64: "AAAA" },
    ]);

    expect(content).toHaveLength(3);
    expect(content[1]).toMatchObject({ type: "text" });
    expect(String(content[1]!.text)).toContain("surface: home");
    expect(String(content[1]!.text)).toContain("viewport: mobile");
    expect(content[2]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
  });

  it("tells the judge what the application is for, and nothing about how it was asked for", () => {
    const [intro] = buildJudgeMessage("A tracker.", []);

    expect(String(intro!.text)).toContain("A tracker.");
  });
});

describe("judgeToolDefinition", () => {
  it("requires an answer for every dimension the schema will demand one for", () => {
    const tool = judgeToolDefinition();
    const schema = tool.input_schema as {
      properties: { dimensions: { properties: Record<string, unknown>; required: string[] } };
    };

    expect(Object.keys(schema.properties.dimensions.properties).sort()).toEqual(
      [...PRODUCT_DIMENSIONS].sort(),
    );
    expect(schema.properties.dimensions.required.sort()).toEqual([...PRODUCT_DIMENSIONS].sort());
  });

  /** Polish is reported and never averaged in, so it must be asked for outside the nine. */
  it("keeps polish out of the dimensions object", () => {
    const schema = judgeToolDefinition().input_schema as {
      properties: Record<string, unknown>;
    };

    expect(Object.keys(schema.properties)).toContain("polish");
  });
});

describe("judgementFrom", () => {
  it("turns a well-formed answer into a judgement the report schema accepts", () => {
    const result = judgementFrom(answer(), INPUT, JUDGE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("judged");
    if (result.value.status !== "judged") return;
    expect(result.value.judge).toEqual(JUDGE);
    expect(Object.keys(result.value.dimensions).sort()).toEqual([...PRODUCT_DIMENSIONS].sort());
  });

  /**
   * The reason the model cites a surface and a viewport rather than a path: it cannot invent
   * one. Every screenshot in the evidence is a file this run actually took.
   */
  it("resolves a citation to the image the run took, rather than trusting a path", () => {
    const result = judgementFrom(answer(), INPUT, JUDGE);

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status !== "judged") return;
    const hierarchy = result.value.dimensions.hierarchy;
    expect(hierarchy.status).toBe("graded");
    if (hierarchy.status !== "graded") return;
    expect(hierarchy.evidence[0]!.screenshot).toBe("home/desktop.png");
  });

  it("reads a citation whose surface is capitalised differently", () => {
    const bent = answer();
    (bent.polish as { evidence: { surface: string }[] }).evidence[0]!.surface = "Home";

    const result = judgementFrom(bent, INPUT, JUDGE);

    expect(result.ok).toBe(true);
  });

  it("refuses a grade whose every citation names an image nobody took", () => {
    const bent = answer();
    (bent.polish as { evidence: { surface: string }[] }).evidence[0]!.surface = "checkout";

    const result = judgementFrom(bent, INPUT, JUDGE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("citing no screenshot this run took");
  });

  it("refuses a grade with no evidence at all", () => {
    const bent = answer();
    (bent.dimensions as Record<string, Record<string, unknown>>).color!.evidence = [];

    const result = judgementFrom(bent, INPUT, JUDGE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("color");
  });

  /** A dimension silently missing shrinks the denominator, and a shrinking denominator scores higher. */
  it("refuses an answer that skipped a dimension", () => {
    const bent = answer();
    delete (bent.dimensions as Record<string, unknown>).restraint;

    expect(judgementFrom(bent, INPUT, JUDGE).ok).toBe(false);
  });

  it("keeps not_assessable, with the reason that makes it a fact rather than a gap", () => {
    const bent = answer();
    (bent.dimensions as Record<string, unknown>).interaction = {
      status: "not_assessable",
      reason: "nothing in either screenshot is interactive",
    };

    const result = judgementFrom(bent, INPUT, JUDGE);

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status !== "judged") return;
    expect(result.value.dimensions.interaction).toEqual({
      status: "not_assessable",
      reason: "nothing in either screenshot is interactive",
    });
  });

  it("refuses not_assessable with no reason, which is indistinguishable from a gap", () => {
    const bent = answer();
    (bent.dimensions as Record<string, unknown>).interaction = { status: "not_assessable" };

    expect(judgementFrom(bent, INPUT, JUDGE).ok).toBe(false);
  });

  it("refuses an answer that is not the shape the tool asked for", () => {
    expect(judgementFrom({ dimensions: "all good" }, INPUT, JUDGE).ok).toBe(false);
  });
});

/** `toolInputOf` reads an already-validated reply, so a test has to go through the parser too. */
function parsedReply(payload: unknown): MessagesReply {
  const parsed = parseMessagesReply(payload);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe("toolInputOf", () => {
  it("finds the judgement in the tool call", () => {
    const result = toolInputOf(
      parsedReply({
        content: [
          { type: "text", text: "Looking now." },
          { type: "tool_use", name: JUDGE_TOOL_NAME, input: { dimensions: {} } },
        ],
      }),
    );

    expect(result).toEqual({ ok: true, value: { dimensions: {} } });
  });

  /** When a model explains itself instead of answering, that sentence is the whole diagnosis. */
  it("quotes what the model said instead of calling the tool", () => {
    const result = toolInputOf(
      parsedReply({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "I can't see the images." }],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("I can't see the images.");
    expect(result.error).toContain("end_turn");
  });
});

describe("parseMessagesReply", () => {
  it("names a response that is not a Messages reply at all", () => {
    const result = parseMessagesReply({ error: { message: "no endpoints found" } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not a Messages reply");
  });

  /** The counters are nullish, not optional: OpenRouter sends nulls for a model that never caches. */
  it("accepts a reply whose usage counters are null", () => {
    const result = parseMessagesReply({
      content: [],
      usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: null },
    });

    expect(result.ok).toBe(true);
  });
});

/**
 * The corpus's own images, so the adapter reads real PNGs off disk rather than a stub — encoding
 * is one of the two things this class does, and a fake file would test the other one twice.
 */
const CORPUS_INPUT: ProductEvaluationInput = {
  taskId: "minimalist-professional",
  runId: "run-1",
  intent: "A small team's task tracker.",
  screenshots: [
    { surfaceId: "home", viewport: "mobile", path: "minimalist-professional/mobile.png" },
    { surfaceId: "home", viewport: "desktop", path: "minimalist-professional/desktop.png" },
  ],
};

function replied(input: unknown, usage?: Record<string, number>): Response {
  return new Response(
    JSON.stringify({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: JUDGE_TOOL_NAME, input }],
      ...(usage === undefined ? {} : { usage }),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("OpenRouterVisionJudge", () => {
  it("sends the images to the Anthropic-shaped endpoint and grades what comes back", async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const judge = new OpenRouterVisionJudge({
      apiKey: "sk-or-test",
      model: "openai/some-model",
      screenshotRoot: CORPUS_ROOT,
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return replied(answer());
      },
    });

    const judgement = await judge.evaluate(CORPUS_INPUT);

    expect(judgement.status).toBe("judged");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://openrouter.ai/api/v1/messages");
    // One call carrying both images: "does this look coherent" is not a per-image question.
    const content = (requests[0]!.body.messages as { content: { type: string }[] }[])[0]!.content;
    expect(content.filter((block) => block.type === "image")).toHaveLength(2);
    expect(requests[0]!.body.tool_choice).toEqual({ type: "tool", name: JUDGE_TOOL_NAME });
  });

  it("reports what the call cost, cache fields included", async () => {
    const seen: JudgeUsage[] = [];
    const judge = new OpenRouterVisionJudge({
      apiKey: "sk-or-test",
      model: "openai/some-model",
      screenshotRoot: CORPUS_ROOT,
      onUsage: (usage) => seen.push(usage),
      fetch: async () =>
        replied(answer(), {
          input_tokens: 100,
          cache_read_input_tokens: 900,
          output_tokens: 40,
        }),
    });

    await judge.evaluate(CORPUS_INPUT);

    expect(seen).toEqual([{ inputTokens: 1_000, outputTokens: 40 }]);
  });

  /**
   * The attempt whose answer is rejected still spent its tokens, and it is exactly the attempt a
   * retry hides. Counting only the usable ones under-reports a run wherever it retried.
   */
  it("reports what a rejected answer cost, not only a usable one", async () => {
    const seen: JudgeUsage[] = [];
    const judge = new OpenRouterVisionJudge({
      apiKey: "sk-or-test",
      model: "openai/some-model",
      screenshotRoot: CORPUS_ROOT,
      maxAttempts: 1,
      onUsage: (usage) => seen.push(usage),
      fetch: async () =>
        new Response(
          JSON.stringify({
            stop_reason: "end_turn",
            content: [{ type: "text", text: "I would rather not." }],
            usage: { input_tokens: 3_000, output_tokens: 12 },
          }),
          { status: 200 },
        ),
    });

    await expect(judge.evaluate(CORPUS_INPUT)).rejects.toThrow();
    expect(seen).toEqual([{ inputTokens: 3_000, outputTokens: 12 }]);
  });

  it("asks again when the first answer is unusable", async () => {
    let calls = 0;
    const judge = new OpenRouterVisionJudge({
      apiKey: "sk-or-test",
      model: "openai/some-model",
      screenshotRoot: CORPUS_ROOT,
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response("upstream fell over", { status: 502 })
          : replied(answer());
      },
    });

    expect((await judge.evaluate(CORPUS_INPUT)).status).toBe("judged");
    expect(calls).toBe(2);
  });

  /**
   * The central refusal. A judge that returned `not_run` here would renormalise its half away and
   * hand back a score that reads exactly like a run nobody judged; one that returned low grades
   * would file its own outage against the model. Throwing is what makes it `errored`/`evaluator`.
   */
  it("throws rather than scoring anything when it cannot grade", async () => {
    const judge = new OpenRouterVisionJudge({
      apiKey: "sk-or-test",
      model: "openai/some-model",
      screenshotRoot: CORPUS_ROOT,
      fetch: async () => new Response("no endpoints found", { status: 404 }),
    });

    await expect(judge.evaluate(CORPUS_INPUT)).rejects.toThrow(/attempt 1.*attempt 2/s);
  });

  /**
   * Absence, not failure: a run whose browser photographed nothing is a fact about that run, and
   * the port already has a word for it. Checked before the request, so it costs nothing.
   */
  it("answers not_run, without spending anything, when there is nothing to look at", async () => {
    let calls = 0;
    const judge = new OpenRouterVisionJudge({
      apiKey: "sk-or-test",
      model: "openai/some-model",
      screenshotRoot: CORPUS_ROOT,
      fetch: async () => {
        calls += 1;
        return replied(answer());
      },
    });

    const judgement = await judge.evaluate({ ...CORPUS_INPUT, screenshots: [] });

    expect(judgement.status).toBe("not_run");
    expect(calls).toBe(0);
  });
});

describe("visionJudgeIdentity", () => {
  /**
   * The route travels with the model, because the same id reached two ways is not obviously the
   * same instrument and a reader months later has nothing else to go on.
   */
  it("records the route as well as the model", () => {
    expect(visionJudgeIdentity("openai/x")).toEqual({
      source: "openrouter:openai/x",
      rubricVersion: "product-2",
    });
  });
});
