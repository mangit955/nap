import { describe, expect, it } from "vitest";
import { modelList } from "../testing/model-list.ts";
import { choiceFor, imagesFor, modelInUse, modelOptions, sendableModel } from "./model-options.ts";

const FREE = { id: "nvidia/nemotron-3.5-super-vl:free", label: "Nemotron", images: true };

describe("model options", () => {
  it("lists the free model first, then the nine lines", () => {
    const options = modelOptions(modelList({ key: null, free: FREE }));
    expect(options.map((option) => option.id)).toEqual([
      FREE.id,
      "astra",
      "sol",
      "luna",
      "fable",
      "opus",
      "sonnet",
      "haiku",
      "muse-wonder",
      "muse-ember",
    ]);
    expect(options[0]).toMatchObject({ free: true, vendor: null, available: true });
  });

  it("reads a draft's exact version as its line, and drops what it cannot place", () => {
    const options = modelOptions(modelList());
    expect(choiceFor(options, "openai/gpt-5.6-sol")?.id).toBe("sol");
    expect(choiceFor(options, "anthropic/claude-opus-5")?.id).toBe("opus");
    expect(choiceFor(options, "opus")?.id).toBe("opus");
    expect(sendableModel(options, "openai/gpt-5.6-terra")).toBeUndefined();
    expect(sendableModel(options, "anthropic/claude-opus-5")).toBe("opus");
  });

  it("sends a value as it is before the list has loaded, for the server to place", () => {
    expect(sendableModel([], "anthropic/claude-opus-5")).toBe("anthropic/claude-opus-5");
  });

  it("sends nothing for a line this caller cannot run, so the default it is shown applies", () => {
    // Sol chosen under an OpenRouter key, then an Anthropic key saved instead.
    const options = modelOptions(modelList({ key: "anthropic" }));
    expect(sendableModel(options, "sol")).toBeUndefined();
    expect(sendableModel(options, "opus")).toBe("opus");
  });

  it("never names a locked line as the one in use", () => {
    const options = modelOptions(modelList({ key: "anthropic" }));
    // The first line an Anthropic key reaches, never the OpenAI line it cannot.
    expect(modelInUse(options, "sol")?.id).toBe("fable");
  });

  it("knows a line takes images before the list has loaded", () => {
    expect(imagesFor([], "sol")).toBe(true);
    expect(imagesFor([], "openai/gpt-oss-20b:free")).toBe(false);
    expect(imagesFor(modelOptions(modelList({ key: null, free: FREE })), FREE.id)).toBe(true);
  });
});
