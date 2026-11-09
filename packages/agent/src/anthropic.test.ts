import { describe, expect, it } from "vitest";
import { toDirectAnthropicModel } from "./anthropic.ts";

describe("toDirectAnthropicModel", () => {
  it("strips the OpenRouter namespace", () => {
    expect(toDirectAnthropicModel("anthropic/claude-opus-5")).toBe("claude-opus-5");
  });

  it("leaves a bare id alone", () => {
    expect(toDirectAnthropicModel("claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("leaves another vendor's id alone rather than making it look valid", () => {
    // An OpenAI model cannot be made to work at Anthropic's API by rewriting its name, and
    // quietly reshaping it would hide the routing mistake the allowlist exists to catch.
    expect(toDirectAnthropicModel("openai/gpt-5.6-luna")).toBe("openai/gpt-5.6-luna");
  });
});
