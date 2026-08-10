import type { NapEvent } from "@nap/shared/events";
import { describe, expect, it } from "vitest";
import { formatEvent, HARNESS_DEFAULTS, oneLine, parseHarnessArgs } from "./harness.ts";

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const TURN_ID = "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";

function parsed(...argv: string[]) {
  const result = parseHarnessArgs(argv);
  if (!result.ok) throw new Error(`expected a parse, got: ${result.error}`);
  return result.value;
}

function rejected(...argv: string[]): string {
  const result = parseHarnessArgs(argv);
  if (result.ok) throw new Error("expected the arguments to be refused");
  return result.error;
}

function event<T extends NapEvent["type"]>(type: T, payload: unknown): NapEvent {
  return {
    type,
    payload,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    seq: 7,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as NapEvent;
}

describe("parseHarnessArgs", () => {
  it("takes the prompt from the words that are not flags", () => {
    expect(parsed("add", "a", "dark", "mode", "toggle").prompt).toBe("add a dark mode toggle");
  });

  it("refuses to run with no prompt", () => {
    expect(rejected("--real")).toMatch(/prompt is required/);
  });

  it("is a dry run unless --real is given", () => {
    // The default is the one that decides whether money is spent, so it is asserted
    // directly rather than implied by the others.
    expect(parsed("build me an app").real).toBe(false);
    expect(parsed("--real", "build me an app").real).toBe(true);
  });

  it("defaults a real run to the cheap configuration", () => {
    const options = parsed("--real", "hello");

    expect(options.model).toBe(HARNESS_DEFAULTS.model);
    expect(options.effort).toBe(HARNESS_DEFAULTS.effort);
    expect(options.maxSteps).toBe(HARNESS_DEFAULTS.maxSteps);
    expect(options.budgetTokens).toBe(HARNESS_DEFAULTS.budgetTokens);
  });

  it("accepts overrides for the model, effort and ceilings", () => {
    const options = parsed(
      "--real",
      "--model=claude-opus-5",
      "--effort=xhigh",
      "--max-steps=3",
      "--budget-tokens=20000",
      "--keep",
      "record the demo",
    );

    expect(options).toStrictEqual({
      prompt: "record the demo",
      real: true,
      platform: "openrouter",
      model: "claude-opus-5",
      effort: "xhigh",
      maxSteps: 3,
      budgetTokens: 20_000,
      keep: true,
    });
  });

  it("bills OpenRouter unless told otherwise, on the cheap model", () => {
    // Both halves of the same decision: this is the route the project uses, and the default
    // model is the one that makes running the loop repeatedly affordable. A default of Sonnet
    // here is a twentyfold difference in what an afternoon of debugging costs.
    expect(parsed("--real", "hi").platform).toBe("openrouter");
    expect(parsed("--real", "hi").model).toBe("openai/gpt-5.6-luna");
  });

  it("can still target Anthropic or Bedrock directly", () => {
    expect(parsed("--real", "--platform=anthropic", "hi").platform).toBe("anthropic");
    expect(parsed("--real", "--platform=bedrock", "hi").platform).toBe("bedrock");
  });

  it("refuses a platform it has no client for", () => {
    expect(rejected("--platform=azure", "hi")).toMatch(/platform must be one of/);
  });

  it("refuses an unknown flag rather than ignoring it", () => {
    // The forgiving version of this parser accepts `--budget-tokns=100` on a real run and
    // quietly spends the default instead.
    expect(rejected("--budget-tokns=100", "hi")).toMatch(/unknown flag/);
  });

  it("refuses an effort level the API does not have", () => {
    expect(rejected("--effort=extreme", "hi")).toMatch(/effort must be one of/);
  });

  it.each(["0", "-5", "abc", "1.5"])("refuses a ceiling of %s", (value) => {
    expect(rejected(`--max-steps=${value}`, "hi")).toMatch(/positive whole number/);
  });
});

describe("formatEvent", () => {
  it("leads with the sequence number and the type, so ordering reads down the page", () => {
    expect(formatEvent(event("turn.started", {}))).toBe("  7  turn.started");
  });

  it("shows which tool ran and what it was given", () => {
    const line = formatEvent(
      event("tool.call", { toolCallId: "c1", toolName: "read_file", input: { path: "/app/x" } }),
    );

    expect(line).toContain("read_file");
    expect(line).toContain("/app/x");
  });

  it("marks a failed tool result loudly, since a turn can succeed despite one", () => {
    const line = formatEvent(
      event("tool.result", { toolCallId: "c1", toolName: "run_command", ok: false, output: "no" }),
    );

    expect(line).toContain("FAILED");
  });

  it("reports usage and the commit a completed turn produced", () => {
    const line = formatEvent(
      event("turn.completed", {
        usage: { inputTokens: 1_200, outputTokens: 90 },
        durationMs: 4_300,
        commitSha: "9e107d9d372bb6826bd81d3542a419d6c2b0f5a1",
      }),
    );

    expect(line).toContain("1200 in / 90 out");
    expect(line).toContain("9e107d9d");
  });

  it("says so plainly when a turn committed nothing", () => {
    const line = formatEvent(
      event("turn.completed", {
        usage: { inputTokens: 1, outputTokens: 1 },
        durationMs: 1,
        commitSha: null,
      }),
    );

    expect(line).toContain("commit none");
  });

  it("keeps a file's contents from taking over the stream", () => {
    const line = formatEvent(
      event("tool.call", {
        toolCallId: "c1",
        toolName: "write_file",
        input: { path: "/app/x", contents: "x".repeat(5_000) },
      }),
    );

    expect(line.length).toBeLessThan(160);
  });
});

describe("oneLine", () => {
  it("collapses whitespace so a multi-line value stays on its row", () => {
    expect(oneLine("one\n\n  two")).toBe("one two");
  });

  it("truncates with an ellipsis past the limit", () => {
    expect(oneLine("abcdef", 4)).toBe("abc…");
  });

  it("leaves text within the limit alone", () => {
    expect(oneLine("abcd", 4)).toBe("abcd");
  });
});
