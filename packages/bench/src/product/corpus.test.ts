import { describe, expect, it } from "vitest";
import { FilenameSafeIdSchema } from "../screenshot.ts";
import { CAPTURE_VIEWPORTS, DEFAULT_SURFACE_ID } from "../surface.ts";
import { scriptedJudgement } from "../testing/scripted-judgement.ts";
import {
  CORPUS_FIXTURES,
  CORPUS_INTENT,
  corpusFixture,
  corpusScreenshotPath,
  corpusSurfaceScreenshots,
} from "./corpus.ts";
import { parseProductJudgement } from "./judgement.ts";

describe("the fixture corpus", () => {
  it("names every fixture uniquely", () => {
    const ids = CORPUS_FIXTURES.map((fixture) => fixture.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names fixtures a screenshot path can be built from", () => {
    for (const fixture of CORPUS_FIXTURES) {
      expect(FilenameSafeIdSchema.safeParse(fixture.id).success).toBe(true);
    }
  });

  it("says what each fixture is built to separate, and says something different each time", () => {
    const reasons = CORPUS_FIXTURES.map((fixture) => fixture.built);

    for (const reason of reasons) expect(reason.length).toBeGreaterThan(0);
    // Two fixtures built for the same reason are one fixture and a duplicate, and the corpus is
    // meant to be nine designs of one application rather than nine copies of some of them.
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it("holds the pairs the discrimination assertions are written against", () => {
    const ids = CORPUS_FIXTURES.map((fixture) => fixture.id);

    // Each of these is one half of an assertion in `discrimination.ts`; a corpus that lost one
    // would leave that expectation permanently unassessable rather than failing.
    expect(ids).toEqual(
      expect.arrayContaining([
        "minimalist-professional",
        "ai-slop-generic",
        "excessive-gradient",
        "excessive-icon",
        "icons-restrained",
        "desktop-only-breaks-mobile",
        "responsive-strong",
        "correct-ugly",
        "broken-beautiful",
      ]),
    );
  });

  /**
   * Structurally, not by agreement: there is one intent constant and no per-fixture field to
   * override it with. A fixture that carried its own sentence would make the corpus nine slightly
   * different experiments rather than one with nine arms, so this fails the moment one grows a
   * field the shared constant does not cover.
   */
  it("gives every fixture the same intent, so design is the only variable", () => {
    expect(CORPUS_INTENT.length).toBeGreaterThan(0);

    for (const fixture of CORPUS_FIXTURES) {
      expect(Object.keys(fixture).toSorted()).toEqual(["built", "id"]);
    }
  });

  it("finds a fixture by id, and nothing by a name it does not have", () => {
    expect(corpusFixture("minimalist-professional")?.id).toBe("minimalist-professional");
    expect(corpusFixture("not-a-fixture")).toBeUndefined();
  });
});

describe("corpusSurfaceScreenshots", () => {
  it("names one surface at every capture viewport", () => {
    const screenshots = corpusSurfaceScreenshots("responsive-strong");

    expect(screenshots).toEqual(
      CAPTURE_VIEWPORTS.map((viewport) => ({
        surfaceId: DEFAULT_SURFACE_ID,
        viewport,
        path: `responsive-strong/${viewport}.png`,
      })),
    );
  });

  it("pairs the two sizes of one surface, which is what responsiveness is graded on", () => {
    const surfaces = new Set(
      corpusSurfaceScreenshots("desktop-only-breaks-mobile").map((shot) => shot.surfaceId),
    );

    expect(surfaces.size).toBe(1);
  });
});

describe("the corpus as evidence", () => {
  /**
   * The schema refuses a grade whose evidence does not name a screenshot, and it constrains the
   * shape of that path. A corpus whose paths it rejects would fail every fixture at parse time on
   * a paid run — after the images had been sent — so it is checked here, where it is free.
   */
  it("produces evidence a judgement parses with", () => {
    for (const fixture of CORPUS_FIXTURES) {
      const judgement = scriptedJudgement(corpusSurfaceScreenshots(fixture.id));
      const parsed = parseProductJudgement(judgement);

      expect(parsed.ok, `${fixture.id}: ${parsed.ok ? "" : parsed.error}`).toBe(true);
    }
  });

  /**
   * `responsiveness` is graded by comparing one surface at two sizes, and the scripted judge is
   * the only free thing that demonstrates the corpus can supply that pair.
   */
  it("gives responsiveness two sizes of one surface to cite", () => {
    const judgement = scriptedJudgement(corpusSurfaceScreenshots("responsive-strong"));
    if (judgement.status !== "judged")
      throw new Error("the scripted judge grades what it is shown");

    const responsiveness = judgement.dimensions.responsiveness;
    if (responsiveness.status !== "graded") throw new Error("expected a grade");

    expect(responsiveness.evidence.map((seen) => seen.viewport).toSorted()).toEqual([
      "desktop",
      "mobile",
    ]);
  });
});

describe("corpusScreenshotPath", () => {
  it("is relative, so it resolves against whichever directory holds the corpus", () => {
    const path = corpusScreenshotPath("correct-ugly", "mobile");

    expect(path).toBe("correct-ugly/mobile.png");
    expect(path.startsWith("/")).toBe(false);
  });
});
