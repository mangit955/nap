import type { LLMProvider, LLMTurn } from "@nap/shared/ports/llm-provider";
import { expect, it, vi } from "vitest";
import { computerLocalSeedProvider, parseComputerLocalOptions } from "./computer-local-config.ts";

it("keeps the default scripted and requires an explicit Codex opt-in", () => {
  expect(parseComputerLocalOptions([])).toEqual({ ok: true, value: { kind: "scripted" } });
  expect(parseComputerLocalOptions(["--codex"])).toEqual({
    ok: true,
    value: { kind: "codex", nativeModel: "gpt-5.6-sol", napModel: "openai/gpt-5.6-sol" },
  });
});

it("normalizes only the honest namespace of the approved subscription model", () => {
  for (const model of ["gpt-5.6-sol", "openai/gpt-5.6-sol"]) {
    expect(parseComputerLocalOptions(["--codex", `--model=${model}`])).toEqual({
      ok: true,
      value: { kind: "codex", nativeModel: "gpt-5.6-sol", napModel: "openai/gpt-5.6-sol" },
    });
  }
  for (const model of ["gpt-6.1-sol", "anthropic/claude-sonnet-5", "", "../model"]) {
    expect(parseComputerLocalOptions(["--codex", `--model=${model}`]).ok).toBe(false);
  }
});

it("rejects model-only, unknown, and duplicate flags instead of enabling inference implicitly", () => {
  for (const args of [
    ["--model=gpt-5.6-sol"],
    ["--real"],
    ["--codex", "--codex"],
    ["--codex", "--model=gpt-5.6-sol", "--model=gpt-5.6-sol"],
  ]) {
    expect(parseComputerLocalOptions(args).ok).toBe(false);
  }
});

it("keeps every seed handle scripted until the explicit barrier, then routes tests and repairs", () => {
  const handle = (): LLMTurn => ({
    usage: () => ({ inputTokens: 0, outputTokens: 0 }),
    complete: vi.fn<LLMTurn["complete"]>(),
  });
  const seed = { startTurn: vi.fn<LLMProvider["startTurn"]>(handle) };
  const interactive = { startTurn: vi.fn<LLMProvider["startTurn"]>(handle) };
  const selected = computerLocalSeedProvider({ seed, interactive });
  const oldSeed = selected.provider.startTurn();
  selected.provider.startTurn();
  expect(seed.startTurn).toHaveBeenCalledTimes(2);
  expect(interactive.startTurn).not.toHaveBeenCalled();
  selected.finishSeed();
  selected.finishSeed();
  for (let turn = 0; turn < 3; turn += 1) {
    selected.provider.startTurn({ model: "openai/gpt-5.6-sol" });
  }
  expect(interactive.startTurn).toHaveBeenCalledTimes(3);
  expect(interactive.startTurn).toHaveBeenLastCalledWith({ model: "openai/gpt-5.6-sol" });
  expect(seed.startTurn).toHaveBeenCalledTimes(2);
  expect(oldSeed).toBe(seed.startTurn.mock.results[0]?.value);
});
