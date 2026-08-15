import { describe, expect, it } from "vitest";
import {
  AccessibilityCheckSchema,
  DEFAULT_FAIL_ON_IMPACT,
  describeViolations,
  disqualifying,
} from "./accessibility-check.ts";
import type { AccessibilityViolation } from "./browser-session.ts";

function violation(overrides: Partial<AccessibilityViolation> = {}): AccessibilityViolation {
  return {
    id: "image-alt",
    impact: "critical",
    help: "Images must have alternate text",
    helpUrl: "https://example.test/image-alt",
    nodes: 1,
    ...overrides,
  };
}

describe("the accessibility check schema", () => {
  it("accepts the smallest thing a task can say", () => {
    const parsed = AccessibilityCheckSchema.safeParse({
      id: "is-accessible",
      kind: "accessibility",
    });

    expect(parsed.success).toBe(true);
  });

  it("refuses a field nobody declared, the way every other check does", () => {
    const parsed = AccessibilityCheckSchema.safeParse({
      id: "is-accessible",
      kind: "accessibility",
      // The typo this schema exists to catch: silently ignored, it produces a check that
      // measured something other than what the author meant.
      failon: "critical",
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses a path that is not a path", () => {
    const parsed = AccessibilityCheckSchema.safeParse({
      id: "is-accessible",
      kind: "accessibility",
      path: "pricing",
    });

    expect(parsed.success).toBe(false);
  });
});

describe("disqualifying", () => {
  it("keeps violations at the threshold and above it", () => {
    const found = [
      violation({ id: "color-contrast", impact: "serious" }),
      violation({ id: "image-alt", impact: "critical" }),
      violation({ id: "region", impact: "moderate" }),
    ];

    expect(disqualifying(found, "serious").map((entry) => entry.id)).toEqual([
      "color-contrast",
      "image-alt",
    ]);
  });

  it("lets a stricter threshold ignore what a looser one would fail on", () => {
    const found = [violation({ id: "region", impact: "moderate" })];

    expect(disqualifying(found, "moderate")).toHaveLength(1);
    expect(disqualifying(found, "serious")).toHaveLength(0);
  });

  it("counts an ungraded violation whatever the threshold", () => {
    // The tool reports only violations, so one it declined to grade is still a violation.
    // Dropping it would let a rule disappear from the benchmark for want of a severity, and
    // guessing `minor` for it would understate it — the type says so, and so does this.
    const found = [violation({ id: "mystery", impact: "unknown" })];

    expect(disqualifying(found, "critical")).toHaveLength(1);
  });

  it("defaults to a threshold that is not the strictest available", () => {
    // Failing on `minor` would fail almost every generated application and stop separating
    // them, which is the one thing a benchmark check must not do.
    expect(DEFAULT_FAIL_ON_IMPACT).toBe("serious");
  });
});

describe("describeViolations", () => {
  it("names the rules, their grades and how many elements each hit", () => {
    const detail = describeViolations(
      [
        violation({ id: "image-alt", impact: "critical", nodes: 3 }),
        violation({ id: "color-contrast", impact: "serious", nodes: 12 }),
      ],
      "serious",
    );

    expect(detail).toMatch(/image-alt/);
    expect(detail).toMatch(/critical/);
    expect(detail).toMatch(/3/);
    expect(detail).toMatch(/color-contrast/);
  });

  it("says what it found rather than only that it found something", () => {
    // `exit 1` with no reason is what let a dead check survive a whole funded run; a check
    // that fails has to say enough that somebody can act without re-running it.
    expect(describeViolations([violation()], "serious")).not.toBe("failed");
  });

  it("reports a clean page as clean, and says at what bar", () => {
    const detail = describeViolations([], "serious");

    expect(detail).toMatch(/no violations/i);
    expect(detail).toMatch(/serious/);
  });
});
