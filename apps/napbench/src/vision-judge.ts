/**
 * The judge that actually looks at the screenshots: a vision model, reached over OpenRouter.
 *
 * This is the far end of the `ProductEvaluation` port. `@nap/bench` may touch no network, so it
 * defines what a judgement *is* and nothing about how one is obtained; everything below —
 * credentials, base64, a tool schema, a retry — lives here, exactly as the Playwright adapter
 * does beside it.
 *
 * **It reuses none of `@nap/agent`, deliberately and structurally.** The agent is the thing under
 * test, and a benchmark whose grader shares its subject's retries, fallbacks and accounting
 * measures neither of them; `LLMContentBlock` also has no image variant, so there is nothing to
 * reuse even if it were wise. The consequence is the plain `fetch` below rather than the Anthropic
 * SDK — that SDK belongs to `@nap/agent` and `test/architecture.ts` enforces it — which is a fair
 * price for a request this small: one message, one tool, no streaming.
 *
 * **Structured output comes back as a tool call, not as prose to be parsed.** A judge asked for
 * JSON in a fenced block is a judge that will one day return two blocks, or a preamble, and the
 * failure is a parse error on an expensive run. `tool_use` through OpenRouter's Anthropic endpoint
 * is measured rather than assumed — see `docs/GOTCHAS.md` — and `tool_choice` makes it the only
 * thing the model can do.
 *
 * **The judge cites a surface and a viewport; we supply the path.** The evidence in a report names
 * a screenshot relative to the results directory, and a model asked to reproduce such a path will
 * eventually invent one — an evidenced grade citing an image that does not exist is worse than an
 * unevidenced one, because it looks checkable. So the model names the view it looked at, in the
 * vocabulary it was shown, and the mapping back to a file is arithmetic done here.
 *
 * **Anything that goes wrong throws.** A judge that answered `not_run` on a transport failure
 * would renormalise the product half away and hand back a report scored on its objective half
 * alone, which reads exactly like a run nobody judged; one that invented low grades would be
 * worse still. A thrown error becomes `errored`/`evaluator` at the composition root, which is the
 * column a broken instrument belongs in.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { POLISH, PRODUCT_DIMENSIONS, type ProductDimension } from "@nap/bench/product/dimension";
import type {
  ProductEvaluation,
  ProductEvaluationInput,
  SurfaceScreenshot,
} from "@nap/bench/product/evaluation";
import { CONFIDENCE_LEVELS, ConfidenceSchema, GRADES, GradeSchema } from "@nap/bench/product/grade";
import {
  type DimensionJudgement,
  type JudgeIdentity,
  type ProductEvidence,
  type ProductJudgement,
  parseProductJudgement,
} from "@nap/bench/product/judgement";
import { VIEWPORT_NAMES, ViewportNameSchema } from "@nap/bench/viewport";
import type { Result } from "@nap/shared/result";
import { z } from "zod";
import { PRODUCT_RUBRIC, PRODUCT_RUBRIC_VERSION } from "./product-rubric.ts";

/**
 * The endpoint, spelled out in full rather than composed from a root.
 *
 * `@nap/agent` keeps the *root* because the Anthropic SDK appends `/v1/messages` itself. Nothing
 * here has an SDK, so the whole address is written down — and written down here rather than
 * imported, because importing it would be the dependency this file exists not to have.
 */
export const OPENROUTER_MESSAGES_URL = "https://openrouter.ai/api/v1/messages";

/** The Messages API version the endpoint expects, exactly as the SDK sends it. */
const ANTHROPIC_VERSION = "2023-06-01";

/** The one thing the model is allowed to do. */
export const JUDGE_TOOL_NAME = "submit_judgement";

/**
 * The ceiling on the answer.
 *
 * Small on purpose: OpenRouter reserves the whole of `max_tokens` against the balance before the
 * request runs — see `docs/GOTCHAS.md` — so a generous ceiling is money that has to be sitting
 * there to ask a question, not money spent. Ten grades with evidence is a couple of thousand
 * tokens; this is roughly double that.
 */
const DEFAULT_MAX_TOKENS = 4_000;

/**
 * How many times one fixture is asked for.
 *
 * Two, and no more. A retry earns its place against a dropped socket or a single malformed
 * answer; a third attempt is mostly paying twice to watch a model fail the same way, and on a
 * suite of nine that is nine extra calls to learn one thing.
 */
const DEFAULT_MAX_ATTEMPTS = 2;

export type VisionJudgeOptions = {
  apiKey: string;
  /** As OpenRouter spells it, vendor-namespaced. */
  model: string;
  /** What the relative paths in a `ProductEvaluationInput` are relative to. */
  screenshotRoot: string;
  maxTokens?: number;
  maxAttempts?: number;
  /** Injected by tests. A judge is one HTTP call, so this is the whole of what has to be faked. */
  fetch?: typeof globalThis.fetch;
  /** Called once per completed request, so a caller can report what a run cost. */
  onUsage?: (usage: JudgeUsage) => void;
};

export type JudgeUsage = { inputTokens: number; outputTokens: number };

/**
 * Who did the grading, as recorded on every judgement this adapter produces.
 *
 * The route is in the string as well as the model, because the same model id reached two ways is
 * not obviously the same instrument and a reader months later has no other way to tell.
 */
export function visionJudgeIdentity(model: string): JudgeIdentity {
  return { source: `openrouter:${model}`, rubricVersion: PRODUCT_RUBRIC_VERSION };
}

/**
 * An empty string means the field was not answered, not that it was answered with nothing.
 *
 * Measured rather than anticipated: the first real call to `openai/gpt-5.6-luna` filled every
 * property the tool schema mentions, including `reason: ""` on the nine dimensions it had just
 * graded. That is a model being tidy about a schema, and refusing a whole judgement over it would
 * throw away nine good grades to punish a blank. The report's own schema still refuses a blank in
 * every place one would mean something — this only decides what counts as *absent* on the way in.
 */
function blankAsAbsent<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional(),
  );
}

const OptionalText = blankAsAbsent(z.string().min(1));

/** The same tidiness, one level down: a list padded with blanks is a list of what is left. */
const textList = z.preprocess(
  (value) =>
    Array.isArray(value)
      ? value.filter((entry) => typeof entry !== "string" || entry.trim() !== "")
      : value,
  z.array(z.string().min(1)).optional(),
);

/**
 * How the model is asked to answer one dimension.
 *
 * Lenient where the strict schema is not — every field optional, `status` an enum rather than a
 * discriminated union — because a model that returns a `reason` alongside a grade should have its
 * grade read rather than the whole nine thrown away over a field nobody needed. What it may not do
 * is grade without evidence, and that is enforced below by construction rather than here.
 */
const RawEvidenceSchema = z.object({
  surface: z.string().min(1),
  viewport: ViewportNameSchema,
  observation: z.string().min(1),
});

const RawDimensionSchema = z.object({
  status: z.enum(["graded", "not_assessable"]),
  grade: blankAsAbsent(GradeSchema),
  // Citations with nothing said in them are dropped here rather than refused, so that the one
  // check that matters — a grade whose evidence is entirely absent — is made in one place below.
  evidence: z
    .preprocess(
      (value) =>
        Array.isArray(value)
          ? value.filter(
              (entry) =>
                typeof entry !== "object" ||
                entry === null ||
                typeof (entry as { observation?: unknown }).observation !== "string" ||
                (entry as { observation: string }).observation.trim() !== "",
            )
          : value,
      z.array(RawEvidenceSchema).optional(),
    )
    .optional(),
  strengths: textList,
  weaknesses: textList,
  confidence: blankAsAbsent(ConfidenceSchema),
  reason: OptionalText,
});

/**
 * The whole answer.
 *
 * `polish` sits beside the dimensions here for the same reason it does in the judgement: it is
 * not one of the nine, and a shape that put it in the record would let it be folded in by anybody
 * who forgot that it must not be.
 */
const JudgeAnswerSchema = z.object({
  dimensions: z.object(
    Object.fromEntries(
      PRODUCT_DIMENSIONS.map((dimension) => [dimension, RawDimensionSchema]),
    ) as Record<ProductDimension, typeof RawDimensionSchema>,
  ),
  polish: RawDimensionSchema,
});

/**
 * The tool the model is forced to call, as a JSON Schema.
 *
 * Built by folding over `PRODUCT_DIMENSIONS` rather than written out, for the reason the rubric
 * is: two hand-maintained copies of the list means one of them is wrong the first time it grows.
 * The *body* of a dimension is still described twice — once here as JSON Schema and once above as
 * Zod — because the Zod side carries preprocessing that has no JSON Schema rendering. The tests
 * pin the dimension key set across both; a divergence in the field set would not be caught, so
 * change the two together.
 *
 * **`required` names `status` and nothing else, deliberately.** `grade` and `evidence` are
 * required only when the status is `graded`, and a `not_assessable` answer must be able to carry
 * neither — a schema that demanded them unconditionally would force a grade out of a judge that
 * had nothing to look at, which is the one thing `not_assessable` exists to prevent. The
 * conditional requirement is stated in each field's `description`, and enforced for real by
 * `judgementFrom`, which refuses a graded dimension with no usable evidence.
 */
export function judgeToolDefinition(): Record<string, unknown> {
  const dimension = {
    type: "object",
    properties: {
      status: { type: "string", enum: ["graded", "not_assessable"] },
      grade: { type: "string", enum: [...GRADES] },
      evidence: {
        type: "array",
        description: "Required whenever status is graded. At least one.",
        items: {
          type: "object",
          properties: {
            surface: { type: "string", description: "The surface, as it was labelled." },
            viewport: { type: "string", enum: [...VIEWPORT_NAMES] },
            observation: {
              type: "string",
              description: "What is in the image. Not a restatement of the grade.",
            },
          },
          required: ["surface", "viewport", "observation"],
        },
      },
      strengths: { type: "array", items: { type: "string" } },
      weaknesses: { type: "array", items: { type: "string" } },
      confidence: { type: "string", enum: [...CONFIDENCE_LEVELS] },
      reason: {
        type: "string",
        description: "Required whenever status is not_assessable: what you had nothing to go on.",
      },
    },
    required: ["status"],
  };

  return {
    name: JUDGE_TOOL_NAME,
    description: "Record your judgement of this application. Every dimension must be answered.",
    input_schema: {
      type: "object",
      properties: {
        dimensions: {
          type: "object",
          properties: Object.fromEntries(
            PRODUCT_DIMENSIONS.map((name) => [name, { ...dimension }]),
          ),
          required: [...PRODUCT_DIMENSIONS],
        },
        polish: { ...dimension },
      },
      required: ["dimensions", "polish"],
    },
  };
}

/**
 * The user message: one sentence of intent, then the images, each announced before it arrives.
 *
 * The label goes *before* its picture rather than after, because that is the only ordering in
 * which a model reading forwards knows what it is looking at while it looks. It is also the
 * vocabulary the evidence has to come back in, which is why it is spelled the same way in both.
 */
export function buildJudgeMessage(
  intent: string,
  images: readonly { screenshot: SurfaceScreenshot; base64: string }[],
): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [
    {
      type: "text",
      text:
        `This application is for: ${intent}\n\n` +
        `Here are ${images.length} screenshot(s) of it. Each is labelled with the surface it ` +
        "shows and the viewport it was taken at; cite them by exactly those two words.",
    },
  ];

  for (const image of images) {
    content.push({
      type: "text",
      text: `Screenshot — surface: ${image.screenshot.surfaceId}, viewport: ${image.screenshot.viewport}`,
    });
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: image.base64 },
    });
  }

  return content;
}

/**
 * The model's answer, turned into the judgement a report can carry — or the reason it could not be.
 *
 * A `Result` rather than a throw because the caller retries on it: this is an expected way for a
 * model to fail, not programmer error. What it refuses is what the report schema refuses, checked
 * by running the assembled judgement back through `parseProductJudgement` rather than by trusting
 * the construction above it — the schema is the authority on what a judgement is, and a second
 * opinion written here would be the copy that drifts.
 */
export function judgementFrom(
  raw: unknown,
  input: ProductEvaluationInput,
  judge: JudgeIdentity,
): Result<ProductJudgement, string> {
  const answer = JudgeAnswerSchema.safeParse(raw);
  if (!answer.success) {
    return { ok: false, error: `the judge's answer did not fit the tool: ${answer.error.message}` };
  }

  const paths = screenshotIndex(input.screenshots);
  const dimensions: Record<string, DimensionJudgement> = {};

  for (const dimension of PRODUCT_DIMENSIONS) {
    const converted = toDimensionJudgement(answer.data.dimensions[dimension], paths);
    if (!converted.ok) return { ok: false, error: `${dimension}: ${converted.error}` };
    dimensions[dimension] = converted.value;
  }

  const polish = toDimensionJudgement(answer.data.polish, paths);
  if (!polish.ok) return { ok: false, error: `${POLISH}: ${polish.error}` };

  return parseProductJudgement({
    status: "judged",
    judge,
    dimensions,
    polish: polish.value,
  });
}

/**
 * A vision model, behind the port.
 *
 * One call per `evaluate`, and every image in it: "does this application look coherent" is not a
 * per-screenshot question, and asking it once per image would both cost more and produce nine
 * unrelated opinions where one judgement was wanted.
 */
export class OpenRouterVisionJudge implements ProductEvaluation {
  readonly #options: Required<Pick<VisionJudgeOptions, "maxAttempts">> & VisionJudgeOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #identity: JudgeIdentity;

  constructor(options: VisionJudgeOptions) {
    this.#options = { ...options, maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#identity = visionJudgeIdentity(options.model);
  }

  async evaluate(input: ProductEvaluationInput): Promise<ProductJudgement> {
    // A judgement over nothing is not a low score, it is an absence — and the port already has a
    // word for it. Returned rather than thrown, and before the request, because a run whose
    // browser never photographed anything is a fact about that run rather than a broken judge.
    if (input.screenshots.length === 0) {
      return {
        status: "not_run",
        reason: `nothing was photographed on ${input.taskId}, so there was nothing to judge`,
      };
    }

    const images = await Promise.all(
      input.screenshots.map(async (screenshot) => ({
        screenshot,
        base64: (await readFile(join(this.#options.screenshotRoot, screenshot.path))).toString(
          "base64",
        ),
      })),
    );

    const body = {
      model: this.#options.model,
      max_tokens: DEFAULT_MAX_TOKENS,
      system: PRODUCT_RUBRIC,
      messages: [{ role: "user", content: buildJudgeMessage(input.intent, images) }],
      tools: [judgeToolDefinition()],
      tool_choice: { type: "tool", name: JUDGE_TOOL_NAME },
    };

    const reasons: string[] = [];

    for (let attempt = 1; attempt <= this.#options.maxAttempts; attempt += 1) {
      const attempted = await this.#ask(body, input);
      if (attempted.ok) return attempted.value;
      reasons.push(`attempt ${attempt}: ${attempted.error}`);
    }

    // Thrown, not returned. See this file's header: the honest destination for a broken
    // instrument is `errored`/`evaluator`, and every other destination reads as a measurement.
    throw new Error(
      `the product judge could not grade ${input.taskId} (${input.runId}) — ${reasons.join("; ")}`,
    );
  }

  async #ask(
    body: unknown,
    input: ProductEvaluationInput,
  ): Promise<Result<ProductJudgement, string>> {
    let response: Response;
    try {
      response = await this.#fetch(OPENROUTER_MESSAGES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // `x-api-key` rather than a bearer token: this is the Anthropic-shaped endpoint, and
          // this is the header the SDK sends to it on the path the rest of the repo has proved.
          "x-api-key": this.#options.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      return { ok: false, error: `the request did not complete: ${messageOf(error)}` };
    }

    const text = await response.text();
    if (!response.ok) {
      return { ok: false, error: `${response.status} ${response.statusText}: ${trim(text)}` };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, error: `the response was not JSON: ${trim(text)}` };
    }

    const parsed = parseMessagesReply(payload);
    if (!parsed.ok) return parsed;

    // Reported before the answer is judged usable, and that ordering is the point: an attempt
    // whose answer is rejected still spent its tokens, and it is exactly the attempt a retry
    // hides. Counting only the successful ones would under-report a run wherever it retried.
    const usage = usageOf(parsed.value);
    if (usage !== undefined) this.#options.onUsage?.(usage);

    const called = toolInputOf(parsed.value);
    if (!called.ok) return called;

    return judgementFrom(called.value, input, this.#identity);
  }
}

/**
 * The tool call the model was told to make, or what it did instead.
 *
 * Read with a schema rather than by walking the object, so a route that answers in some other
 * shape produces a sentence naming what came back instead of a `TypeError` several frames away.
 */
const MessagesResponseSchema = z.object({
  stop_reason: z.string().nullish(),
  content: z.array(
    z.union([
      z.object({ type: z.literal("tool_use"), name: z.string(), input: z.unknown() }),
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.string() }),
    ]),
  ),
  // Every counter nullish rather than optional: OpenRouter answers with `cache_creation_input_
  // tokens: null` for a model that does no prompt caching, and a schema that only tolerated an
  // absent field would refuse the whole response — costing a paid judgement over a token count
  // nothing decides on.
  usage: z
    .object({
      input_tokens: z.number().nullish(),
      output_tokens: z.number().nullish(),
      cache_read_input_tokens: z.number().nullish(),
      cache_creation_input_tokens: z.number().nullish(),
    })
    .nullish(),
});

export type MessagesReply = z.infer<typeof MessagesResponseSchema>;

/**
 * The response, read once.
 *
 * Split from the two readers below rather than parsed inside each, because both of them want the
 * same object and a call that cost real money should be validated once — and because the usage
 * has to be read even when the tool call is missing, which two independent parses made awkward
 * enough to get wrong.
 */
export function parseMessagesReply(payload: unknown): Result<MessagesReply, string> {
  const parsed = MessagesResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: `the response was not a Messages reply: ${parsed.error.message}` };
  }

  return { ok: true, value: parsed.data };
}

export function toolInputOf(reply: MessagesReply): Result<unknown, string> {
  for (const block of reply.content) {
    if (block.type === "tool_use" && "name" in block && block.name === JUDGE_TOOL_NAME) {
      return { ok: true, value: block.input };
    }
  }

  // The prose is quoted rather than discarded: when a model refuses or explains itself instead of
  // calling the tool, that sentence is the entire diagnosis.
  const said = reply.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join(" ");

  return {
    ok: false,
    error:
      `the judge did not call ${JUDGE_TOOL_NAME} (stop_reason ${reply.stop_reason ?? "unset"})` +
      `${said === "" ? "" : `: ${trim(said)}`}`,
  };
}

/**
 * What the call cost, in Anthropic's shape.
 *
 * Both cache fields are summed into the input side for the reason `toTokenUsage` does it in
 * `@nap/agent`: `input_tokens` on this API is the uncached remainder, so reading it alone
 * under-reports a prompt by most of itself.
 */
function usageOf(reply: MessagesReply): JudgeUsage | undefined {
  if (reply.usage == null) return undefined;

  const usage = reply.usage;
  return {
    inputTokens:
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
  };
}

type ScreenshotIndex = ReadonlyMap<string, string>;

/**
 * Every image the judge was shown, keyed the way it was asked to cite it.
 *
 * Case-folded on the surface id alone. A model that writes `Home` for a surface labelled `home`
 * has cited the right picture and spelled it in prose, and refusing that would throw away a
 * whole judgement over capitalisation; the viewport is a closed set the schema has already
 * validated, so it needs no such tolerance.
 */
function screenshotIndex(screenshots: readonly SurfaceScreenshot[]): ScreenshotIndex {
  return new Map(
    screenshots.map((screenshot) => [
      indexKey(screenshot.surfaceId, screenshot.viewport),
      screenshot.path,
    ]),
  );
}

function indexKey(surfaceId: string, viewport: string): string {
  return `${surfaceId.trim().toLowerCase()} ${viewport}`;
}

function toDimensionJudgement(
  raw: z.infer<typeof RawDimensionSchema>,
  paths: ScreenshotIndex,
): Result<DimensionJudgement, string> {
  if (raw.status === "not_assessable") {
    return raw.reason === undefined
      ? { ok: false, error: "answered not_assessable without saying what it had nothing to go on" }
      : { ok: true, value: { status: "not_assessable", reason: raw.reason } };
  }

  if (raw.grade === undefined) return { ok: false, error: "answered graded with no grade" };

  const evidence: ProductEvidence[] = [];
  for (const cited of raw.evidence ?? []) {
    const path = paths.get(indexKey(cited.surface, cited.viewport));
    // Dropped rather than refused. A model that cites one image it was shown and one it invented
    // has still made a checkable argument, and the emptiness check below is what catches the case
    // where it invented all of them — which is the one that matters.
    if (path === undefined) continue;

    evidence.push({
      surfaceId: cited.surface.trim().toLowerCase(),
      viewport: cited.viewport,
      screenshot: path,
      observation: cited.observation,
    });
  }

  if (evidence.length === 0) {
    return {
      ok: false,
      error: `graded ${raw.grade} citing no screenshot this run took`,
    };
  }

  return {
    ok: true,
    value: {
      status: "graded",
      grade: raw.grade,
      evidence,
      strengths: raw.strengths ?? [],
      weaknesses: raw.weaknesses ?? [],
      ...(raw.confidence === undefined ? {} : { confidence: raw.confidence }),
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Enough of a body to diagnose it, and not enough to bury the run's output. */
function trim(text: string): string {
  return text.length <= 400 ? text : `${text.slice(0, 400)}…`;
}
