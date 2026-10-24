/** One paid request per model, using the production nested tool-result mapper. */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { toRequestParams, toTurnResult } from "@nap/agent/claude-provider";
import { createOpenRouterClient } from "@nap/agent/openrouter";
import type { LLMRequest } from "@nap/shared/ports/llm-provider";
import { z } from "zod";

const models = ["anthropic/claude-sonnet-5", "anthropic/claude-opus-5"];
const args = process.argv.slice(2);
if (!args.includes("--real")) {
  console.log(JSON.stringify({ real: false, models, requestsPerModel: 1, maxOutputTokens: 512 }));
  process.exit(0);
}
if (!args.includes("--budget-usd=1"))
  throw new Error("Real probes require the approved --budget-usd=1 flag.");
const output = resolve(
  args.find((arg) => arg.startsWith("--output="))?.slice(9) ?? ".scratch/computer-use/spike-1024",
);
const desktop = z
  .object({
    status: z.literal("completed"),
    marker: z.string().regex(/^NAP-[0-9A-F]{8}$/),
    markerVerified: z.literal(true),
    frameSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .parse(JSON.parse(readFileSync(`${output}/desktop.json`, "utf8")));
const reportPath = `${output}/models.json`;
if (existsSync(reportPath))
  throw new Error("An attempted model probe already exists here. No automatic paid retry.");
const frame = readFileSync(`${output}/frame-4.jpg`);
if (createHash("sha256").update(frame).digest("hex") !== desktop.frameSha256)
  throw new Error("The preflight screenshot hash does not match.");
if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required.");
const image = frame.toString("base64");
const results: {
  model: string;
  status: string;
  usage?: { inputTokens: number; outputTokens: number };
  toolCalls?: unknown;
  error?: string;
}[] = [];
const client = createOpenRouterClient();
for (const model of models) {
  const row: (typeof results)[number] = { model, status: "attempting" };
  results.push(row);
  writeFileSync(reportPath, JSON.stringify({ results }, null, 2));
  const request: LLMRequest = {
    systemPrompt:
      "Read the large NAP- marker visible in the screenshot returned by the computer. Call report_probe with that exact marker. It is available only in the image. Do not guess.",
    maxOutputTokens: 512,
    messages: [
      { role: "user", content: "Inspect the computer screenshot and report its marker." },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "computer_probe",
            name: "computer",
            input: { actions: [{ action: "screenshot" }] },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: "computer_probe",
            isError: false,
            content: [
              { type: "text", text: "Screenshot of the project desktop." },
              { type: "image", mediaType: "image/jpeg", data: image },
            ],
          },
        ],
      },
    ],
    tools: [
      {
        name: "computer",
        description: "Observe the project desktop.",
        inputSchema: {
          type: "object",
          properties: { actions: { type: "array" } },
          required: ["actions"],
        },
      },
      {
        name: "report_probe",
        description: "Report the exact visible marker.",
        inputSchema: {
          type: "object",
          properties: { marker: { type: "string" } },
          required: ["marker"],
          additionalProperties: false,
        },
      },
    ],
  };
  const body = toRequestParams(request, { model, effort: "low", maxTokens: 512 });
  body.thinking = { type: "disabled" };
  delete body.output_config;
  try {
    const message = await client.messages
      .stream(
        { ...body, tool_choice: { type: "tool", name: "report_probe" } },
        { signal: AbortSignal.timeout(60000) },
      )
      .finalMessage();
    const result = toTurnResult(message);
    row.usage = result.usage;
    if (result.type !== "message") throw new Error(`Model returned ${result.type}.`);
    row.toolCalls = result.toolCalls;
    const report = result.toolCalls.find((call) => call.name === "report_probe");
    const parsed = z.object({ marker: z.string() }).safeParse(report?.input);
    if (!parsed.success || parsed.data.marker !== desktop.marker)
      throw new Error("The structured marker did not match the image.");
    row.status = "passed";
  } catch (error) {
    row.status = "failed";
    row.error = error instanceof Error ? error.message : "Unknown model probe failure";
    process.exitCode = 1;
  }
  writeFileSync(reportPath, JSON.stringify({ results }, null, 2));
  console.log(JSON.stringify(row));
}
