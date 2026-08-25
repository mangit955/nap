/**
 * Answers one question, once, with real money: does a vision model accept an image through the
 * OpenRouter path this repo uses?
 *
 * `bun run napbench:vision-spike --real --model=openai/gpt-5.6-luna`
 *
 * The whole product half rests on the answer and nothing in this repository had ever asked it.
 * OpenRouter's model registry says an id takes `image` input, which is a claim about the *model*;
 * what a benchmark run depends on is the claim about the *route* — that the Anthropic-shaped
 * `/v1/messages` endpoint forwards an `image` content block to a non-Anthropic model, and answers
 * with the `tool_use` block the judge's structured output is carried in. Those are two different
 * facts and only the second one can fail a funded run.
 *
 * So this sends exactly one real judgement, of one committed corpus fixture, through the real
 * adapter. Not a hand-rolled probe: the point is to exercise `OpenRouterVisionJudge` itself, since
 * a spike that proved a simpler request works would prove the wrong thing.
 *
 * One fixture, two images, a few thousand tokens. It costs a fraction of a cent and it is the
 * cheapest possible thing to buy before pinning a model in code.
 */

import { join } from "node:path";
import {
  CORPUS_FIXTURES,
  CORPUS_INTENT,
  corpusSurfaceScreenshots,
} from "@nap/bench/product/corpus";
import { PRODUCT_DIMENSIONS } from "@nap/bench/product/dimension";
import { scoreProduct } from "@nap/bench/product/product-score";
import { loadEnvFile } from "@nap/shared/env-file";
import { CORPUS_ROOT, missingCorpusArtefacts } from "../src/corpus-fixtures.ts";
import { OpenRouterVisionJudge } from "../src/vision-judge.ts";

const USAGE = [
  "Usage: bun run napbench:vision-spike --real --model=<openrouter model id>",
  "",
  "  --real            actually send the request. Without it, nothing is spent and nothing is",
  "                    learned — there is no useful fake here, since whether the route carries an",
  "                    image is the entire question.",
  "  --model=<id>      required, and deliberately has no default: nothing may name a judge model",
  "                    until a run of this script has confirmed it.",
  "  --fixture=<id>    which corpus fixture to send. Defaults to the top of the corpus.",
].join("\n");

/** The best-looking fixture, so a plausible answer is also a recognisable one. */
const DEFAULT_FIXTURE = "minimalist-professional";

const args = process.argv.slice(2);
const real = args.includes("--real");
const model = flagValue("--model");
const named = flagValue("--fixture") ?? DEFAULT_FIXTURE;
// Checked against the corpus rather than cast into it. A mistyped `--fixture` would otherwise
// reach `corpusSurfaceScreenshots` as a non-member of the union, and the spike would fail on a
// missing file several steps from the flag that caused it — on the one script whose whole job is
// to spend money once and come back with a clear answer.
const fixture = CORPUS_FIXTURES.find((entry) => entry.id === named);

if (!real) {
  console.log(
    [
      "Dry run. With --real this would send one request to OpenRouter's Anthropic-shaped",
      `/v1/messages endpoint, carrying the two committed screenshots of "${named}" and the`,
      "product rubric, and print whether a judgement came back.",
      "",
      USAGE,
    ].join("\n"),
  );
  process.exit(0);
}

if (model === undefined) {
  console.error(`--model is required.\n\n${USAGE}`);
  process.exit(1);
}

if (fixture === undefined) {
  console.error(
    `there is no corpus fixture called "${named}". It is one of:\n` +
      CORPUS_FIXTURES.map((entry) => `  ${entry.id}`).join("\n"),
  );
  process.exit(1);
}

const ENV_FILE = join(import.meta.dirname, "..", "..", "..", "apps", "api", ".env");
loadEnvFile(ENV_FILE, process.env);

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error(`OPENROUTER_API_KEY is not set. Add it to ${ENV_FILE}, or export it, then retry.`);
  process.exit(1);
}

const missing = missingCorpusArtefacts();
if (missing.length > 0) {
  console.error(`the corpus is missing ${missing.join(", ")} — run bun run napbench:corpus first.`);
  process.exit(1);
}

console.log(
  `REAL RUN — one judgement of "${fixture.id}" on ${model}, via OpenRouter. Costs money.\n`,
);

// One attempt, not the adapter's usual two: a spike asking whether the route works must not
// quietly answer "yes, on the second try" — the retry is a production kindness and would hide
// exactly the intermittency worth knowing about here.
const judge = new OpenRouterVisionJudge({
  apiKey,
  model,
  screenshotRoot: CORPUS_ROOT,
  maxAttempts: 1,
  onUsage: (usage) => console.log(`  usage: ${usage.inputTokens} in, ${usage.outputTokens} out`),
});

const startedAt = Date.now();
let judgement: Awaited<ReturnType<typeof judge.evaluate>>;
try {
  judgement = await judge.evaluate({
    taskId: fixture.id,
    runId: `vision-spike-${new Date().toISOString()}`,
    intent: CORPUS_INTENT,
    // Deliberately the same helper a real corpus run uses, so a spike that passes is evidence
    // about the thing that will run rather than about a request written to succeed.
    screenshots: corpusSurfaceScreenshots(fixture.id),
  });
} catch (error) {
  console.error(`\nNo. ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

console.log(`  answered in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);

if (judgement.status !== "judged") {
  console.error(`No usable judgement: ${judgement.reason}`);
  process.exit(1);
}

for (const dimension of PRODUCT_DIMENSIONS) {
  const answer = judgement.dimensions[dimension];
  if (answer.status !== "graded") {
    console.log(`  ${dimension.padEnd(15, " ")} not assessable — ${answer.reason}`);
    continue;
  }

  // The first citation only. The point of printing evidence here is that a reader can check one
  // grade against one picture; a spike that dumped every observation would be read as a report.
  const [cited] = answer.evidence;
  console.log(
    `  ${dimension.padEnd(15, " ")} ${answer.grade.padEnd(10, " ")} ` +
      `${cited?.surfaceId}@${cited?.viewport}: ${cited?.observation}`,
  );
}

const scored = scoreProduct(judgement);
console.log(
  `\n  polish (reported, never scored): ${
    judgement.polish.status === "graded" ? judgement.polish.grade : "not assessable"
  }`,
);
console.log(`  product half: ${scored?.score ?? "—"} over ${scored?.assessed ?? 0} dimension(s)`);
console.log(
  `\nYes — ${model} accepted image input through OpenRouter's Anthropic-shaped endpoint and\n` +
    "answered with a tool call the schema accepted.",
);

function flagValue(flag: string): string | undefined {
  const found = args.find((arg) => arg.startsWith(`${flag}=`));
  return found?.slice(flag.length + 1);
}
