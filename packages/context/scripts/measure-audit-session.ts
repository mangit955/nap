/**
 * What a four-turn session actually spends its window on.
 *
 * Replays the committed log of one funded run — the finance dashboard whose fourth turn was
 * abandoned on `budget_exceeded` — through the real assembler, one turn at a time, and prints
 * where the tokens went. It spends nothing: the log is a file, the sandbox is a stub, and no
 * model is called.
 *
 * The number it exists to explain is not the assembled context's size. A turn is many model
 * calls and each one re-sends the whole transcript, so the turn's bill is roughly the
 * assembled size *times the number of round trips*, and that product is what the turn budget
 * caps. Printing only the first would make a turn that costs 400,000 tokens look like one
 * that costs 30,000.
 *
 * Run it with `bun packages/context/scripts/measure-audit-session.ts`.
 */

import { readFileSync } from "node:fs";
import type { NapEvent } from "@nap/shared/events";
import { NapContextEngine } from "../src/context-engine.ts";
import { NoopMemoryProvider } from "../src/noop-memory-provider.ts";
import { stubSandbox } from "../src/testing/stub-sandbox.ts";
import { estimateTokens } from "../src/tokens.ts";

const LOG_PATH = new URL("../../../apps/web/src/testing/audit-session.json", import.meta.url);

/** What the deployed composition runs at — `apps/api/src/env.ts`. */
const DEPLOYED_CONTEXT_BUDGET = 80_000;

type Row = { turn: number; [column: string]: number | string };

function loadLog(): NapEvent[] {
  return JSON.parse(readFileSync(LOG_PATH, "utf8")) as NapEvent[];
}

/** Round trips through the model, which is what the transcript is re-sent for. */
function stepsOf(events: NapEvent[]): number {
  // A step ends at the model's turn boundary: every batch of tool calls is one, plus the
  // final call that answered without asking for a tool.
  let steps = 0;
  let inBatch = false;
  for (const event of events) {
    if (event.type === "tool.call") {
      if (!inBatch) steps += 1;
      inBatch = true;
      continue;
    }
    if (event.type === "tool.result") continue;
    inBatch = false;
  }
  return steps + 1;
}

type Composition = { prompts: number; prose: number; toolCalls: number; toolOutput: number };

function categorize(events: NapEvent[]): Composition {
  const totals = { prompts: 0, prose: 0, toolCalls: 0, toolOutput: 0 };
  for (const event of events) {
    switch (event.type) {
      case "user.message":
        totals.prompts += estimateTokens(event.payload.text);
        break;
      case "agent.message":
        totals.prose += estimateTokens(event.payload.text);
        break;
      case "tool.call":
        totals.toolCalls += estimateTokens(
          `${event.payload.toolName}${JSON.stringify(event.payload.input)}`,
        );
        break;
      case "tool.result":
        totals.toolOutput += estimateTokens(event.payload.output);
        break;
      default:
        break;
    }
  }
  return totals;
}

async function main(): Promise<void> {
  const log = loadLog();
  const turnIds = [...new Set(log.map((event) => event.turnId))];
  const engine = new NapContextEngine({ budgetTokens: DEPLOYED_CONTEXT_BUDGET });
  const sandbox = stubSandbox({});
  const memory = new NoopMemoryProvider();

  const composition: Row[] = [];
  const assembled: Row[] = [];

  for (const [index, turnId] of turnIds.entries()) {
    const own = log.filter((event) => event.turnId === turnId);
    const history = log.filter(
      (event) => turnIds.indexOf(event.turnId) < index && event.type !== "turn.started",
    );
    const prompt = own.find((event) => event.type === "user.message");
    if (prompt === undefined || prompt.type !== "user.message") continue;

    const raw = categorize(history);
    const rawTotal = raw.prompts + raw.prose + raw.toolCalls + raw.toolOutput;

    composition.push({
      turn: index + 1,
      prompts: raw.prompts,
      prose: raw.prose,
      "tool calls": raw.toolCalls,
      "tool output": raw.toolOutput,
      "history total": rawTotal,
      "tool output %": rawTotal === 0 ? 0 : Math.round((raw.toolOutput / rawTotal) * 100),
    });

    const built = await engine.build({
      sessionId: prompt.sessionId,
      sandboxId: "stub",
      userMessage: prompt.payload.text,
      history,
      sandbox,
      memory,
    });

    const steps = stepsOf(own);
    assembled.push({
      turn: index + 1,
      "assembled tokens": built.estimatedTokens,
      "steps taken": steps,
      "input re-sent": built.estimatedTokens * steps,
    });
  }

  console.log("\nWhat the transcript is made of, before assembly (estimated tokens):");
  console.table(composition);
  console.log("\nWhat one turn costs, at the deployed 80,000-token context budget:");
  console.table(assembled);
}

await main();
