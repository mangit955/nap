import type { ScriptedTurn } from "@nap/agent/testing/scripted-llm-provider";
import { modelSupportsImages } from "@nap/shared/model-capabilities";
import type { Result } from "@nap/shared/result";
import { RELIABILITY_APP_IDS } from "./computer-reliability-apps.ts";

type AppId = (typeof RELIABILITY_APP_IDS)[number];
export type ReliabilityOptions = {
  /** `null` is the scripted model: no network, no spend, and a verdict that is always passed. */
  model: string | null;
  apps: AppId[];
  runs: number;
  out: string | null;
  /** Required for any model that is not `:free`, so nothing is spent by accident. */
  allowSpend: boolean;
  /** Stop starting runs once the key has spent this much, in US dollars. Comes with `allowSpend`. */
  maxSpendUsd: number | null;
};

export function parseReliabilityArgs(
  args: readonly string[],
): Result<ReliabilityOptions, { message: string }> {
  const refuse = (message: string) => ({ ok: false as const, error: { message } });
  const options: ReliabilityOptions = {
    model: null,
    apps: [...RELIABILITY_APP_IDS],
    runs: 10,
    out: null,
    allowSpend: false,
    maxSpendUsd: null,
  };
  const seen = new Set<string>();
  for (const arg of args) {
    const [flag = "", value = ""] = arg.split(/=(.*)/s);
    if (seen.has(flag)) return refuse(`Repeated flag: ${flag}`);
    seen.add(flag);
    if (arg === "--allow-spend") options.allowSpend = true;
    else if (flag === "--model" && modelSupportsImages(value)) options.model = value;
    else if (flag === "--model")
      return refuse(`${value} is not a model Nap lets use the computer.`);
    else if (flag === "--apps") {
      const apps = value.split(",");
      if (
        !apps.every((app): app is AppId => (RELIABILITY_APP_IDS as readonly string[]).includes(app))
      )
        return refuse(`--apps takes a comma-separated subset of ${RELIABILITY_APP_IDS.join(",")}.`);
      options.apps = apps;
    } else if (
      flag === "--runs" &&
      /^\d+$/.test(value) &&
      Number(value) >= 1 &&
      Number(value) <= 100
    )
      options.runs = Number(value);
    else if (flag === "--out" && value.trim()) options.out = value;
    else if (flag === "--max-spend" && /^\d+(\.\d+)?$/.test(value) && Number(value) > 0)
      options.maxSpendUsd = Number(value);
    else return refuse(`Unknown or invalid argument: ${arg}`);
  }
  // Consent and a ceiling arrive together: consent with no ceiling has no stopping point.
  if (options.allowSpend !== (options.maxSpendUsd !== null))
    return refuse("--allow-spend and --max-spend=<usd> are given together or not at all.");
  return { ok: true, value: options };
}

const computer = (id: string, actions: unknown[]) => ({
  toolCalls: [{ id, name: "computer", input: { actions } }],
});

/**
 * A test turn with no judgement in it: set up, declare one assertion, click, look, pass.
 *
 * What a scripted run measures is everything around the model — the machine, the desktop's cold
 * start, input, screenshots reaching the model, the ledger, the recording — so a failure here is
 * Nap's alone. It clicks the middle of the screen, which is harmless on every app here.
 */
export function scriptedTestTurn(): ScriptedTurn {
  const assertion = {
    type: "assertion",
    id: "app-visible",
    expectation: "The app is still shown after a click on the page.",
  };
  return [
    computer("setup", [
      { action: "annotate", annotation: { type: "setup", description: "Open the app." } },
      { action: "screenshot" },
    ]),
    computer("input", [
      {
        action: "annotate",
        annotation: { type: "test_start", id: "visible", description: "Click the page" },
      },
      { action: "annotate", annotation: { ...assertion, result: "untested" } },
      { action: "annotate", annotation: { type: "action", description: "Click the page body." } },
      { action: "left_click", coordinate: [512, 700] },
      { action: "wait", duration: 0.5 },
      { action: "screenshot" },
    ]),
    computer("verdict", [{ action: "annotate", annotation: { ...assertion, result: "passed" } }]),
    { text: "The scripted check passed." },
  ];
}
