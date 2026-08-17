import { describe, expect, it } from "vitest";
import { type GitReader, harnessIdentity } from "./harness-identity.ts";

const COMMIT = "9e107d9d372bb6826bd81d3542a419d6c2b0f5a1";

/** A git that answers `rev-parse` and `status` from a table, and refuses anything absent. */
function git(answers: Record<string, string | null>): GitReader {
  return (args) => answers[args[0] ?? ""] ?? null;
}

describe("harnessIdentity", () => {
  it("names the commit the run is being performed at", () => {
    const identity = harnessIdentity({
      git: git({ "rev-parse": `${COMMIT}\n`, status: "" }),
      verification: true,
    });

    expect(identity).toStrictEqual({ commit: COMMIT, dirty: false, verification: true });
  });

  it("records what the composition did about verification, since git cannot know it", () => {
    const identity = harnessIdentity({
      git: git({ "rev-parse": COMMIT, status: "" }),
      verification: false,
    });

    expect(identity?.verification).toBe(false);
  });

  it("says the tree was modified, because the sha is then only approximate", () => {
    const identity = harnessIdentity({
      git: git({
        "rev-parse": COMMIT,
        status: " M packages/runtime/src/single-agent-runtime.ts\n",
      }),
      verification: true,
    });

    expect(identity?.dirty).toBe(true);
  });

  it("assumes modified when git would not say whether it was", () => {
    // Under-claiming on purpose: an identity that silently reads as clean is the one a reader
    // would trust, and it is the one nothing proved.
    const identity = harnessIdentity({
      git: git({ "rev-parse": COMMIT, status: null }),
      verification: true,
    });

    expect(identity?.dirty).toBe(true);
  });

  it("records nothing at all when there is no checkout to identify", () => {
    // Unrecorded rather than a placeholder — the same answer a pre-V2 report gives, and the one
    // a comparison already knows not to draw a conclusion from.
    expect(harnessIdentity({ git: git({}), verification: true })).toBeNull();
    expect(harnessIdentity({ git: git({ "rev-parse": "\n" }), verification: true })).toBeNull();
  });
});
