import { TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import { describe, expect, it } from "vitest";
import { parseProjectPath, parseSessionId } from "./params.ts";

describe("parseSessionId", () => {
  it("accepts a uuid", () => {
    const id = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";

    expect(parseSessionId(id)).toEqual({ ok: true, value: id });
  });

  it.each([
    ["missing", undefined],
    ["not a uuid", "nope"],
    ["empty", ""],
  ])("refuses a session id that is %s", (_name, raw) => {
    expect(parseSessionId(raw)).toMatchObject({ ok: false });
  });
});

describe("parseProjectPath", () => {
  it("resolves a project path against the sandbox working directory", () => {
    expect(parseProjectPath("src/App.tsx")).toEqual({
      ok: true,
      value: { relative: "src/App.tsx", absolute: `${TEMPLATE_WORKDIR}/src/App.tsx` },
    });
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["absolute", "/etc/passwd"],
    ["climbing out of the project", "../../etc/passwd"],
    ["climbing out from inside", "src/../../root/.ssh/id_rsa"],
    ["carrying a null byte", "src/App.tsx\0"],
  ])("refuses a path that is %s", (_name, raw) => {
    // This is the boundary a browser types into. Everything it can name has to stay inside
    // the project, or the endpoint reads the sandbox's own filesystem on request.
    expect(parseProjectPath(raw)).toMatchObject({ ok: false });
  });

  it("explains what was wrong", () => {
    const result = parseProjectPath("../secrets");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/project/i);
  });

  it("hands back the path it was given, so a client can key on it", () => {
    // The relative form is what the listing endpoint returned and what the client stored;
    // rewriting it here would mean the viewer and the tree disagree about the same file.
    const result = parseProjectPath("src/components/Header.tsx");

    expect(result).toMatchObject({ ok: true, value: { relative: "src/components/Header.tsx" } });
  });
});
