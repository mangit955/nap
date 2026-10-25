import type { LLMProvider } from "@nap/shared/ports/llm-provider";
import type { Result } from "@nap/shared/result";

export function parseComputerLocalOptions(
  argv: readonly string[],
): Result<
  { kind: "scripted" } | { kind: "codex"; nativeModel: string; napModel: string },
  { message: string }
> {
  let codex = false;
  let model: string | undefined;
  for (const arg of argv) {
    if (arg === "--codex" && !codex) codex = true;
    else if (arg.startsWith("--model=") && model === undefined) model = arg.slice(8);
    else return { ok: false, error: { message: `Unknown or repeated local option: ${arg}` } };
  }
  if (!codex) {
    return model === undefined
      ? { ok: true, value: { kind: "scripted" } }
      : { ok: false, error: { message: "--model requires --codex." } };
  }
  if (model !== undefined && model !== "gpt-5.6-sol" && model !== "openai/gpt-5.6-sol") {
    return {
      ok: false,
      error: { message: "This local subscription test supports only gpt-5.6-sol." },
    };
  }
  return {
    ok: true,
    value: { kind: "codex", nativeModel: "gpt-5.6-sol", napModel: "openai/gpt-5.6-sol" },
  };
}

export function computerLocalSeedProvider(options: {
  seed: LLMProvider;
  interactive: LLMProvider;
}): { provider: LLMProvider; finishSeed(): void } {
  let seeded = false;
  return {
    provider: {
      startTurn: (turnOptions) =>
        (seeded ? options.interactive : options.seed).startTurn(turnOptions),
    },
    finishSeed() {
      seeded = true;
    },
  };
}
