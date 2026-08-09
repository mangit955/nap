import { describe, expect, it } from "vitest";
import { loadEnvFile, parseEnvFile } from "./env-file.ts";

describe("parseEnvFile", () => {
  it("reads plain assignments", () => {
    expect(parseEnvFile("E2B_API_KEY=abc123")).toStrictEqual({ E2B_API_KEY: "abc123" });
  });

  it("strips surrounding quotes, which a shell would have removed", () => {
    expect(parseEnvFile(`A="one"\nB='two'`)).toStrictEqual({ A: "one", B: "two" });
  });

  it("keeps quotes that are inside the value", () => {
    expect(parseEnvFile(`A=say "hi"`)).toStrictEqual({ A: `say "hi"` });
  });

  it("ignores blank lines and comments", () => {
    expect(parseEnvFile("\n# a comment\n  \nA=1\n")).toStrictEqual({ A: "1" });
  });

  it("keeps an empty value rather than dropping the key", () => {
    // A key present but empty is how a credential file says "deliberately unset", and
    // dropping it would make it indistinguishable from a typo in the name.
    expect(parseEnvFile("A=")).toStrictEqual({ A: "" });
  });

  it("takes the last assignment when a key repeats", () => {
    expect(parseEnvFile("A=1\nA=2")).toStrictEqual({ A: "2" });
  });

  it("ignores lines that are not assignments", () => {
    expect(parseEnvFile("just some prose\n1BAD=x")).toStrictEqual({});
  });
});

describe("loadEnvFile", () => {
  it("does nothing when the file does not exist", () => {
    const env: Record<string, string | undefined> = {};

    loadEnvFile("/nowhere/at/all/.env", env);

    expect(env).toStrictEqual({});
  });

  it("leaves an already-set variable alone", () => {
    // Exporting a variable on the command line is a deliberate override; a file silently
    // winning over it is a debugging session nobody enjoys.
    const env: Record<string, string | undefined> = { A: "from the shell" };

    loadEnvFile(new URL("./env-file.test.ts", import.meta.url).pathname, env);

    expect(env.A).toBe("from the shell");
  });
});
