import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RELIABILITY_APP_IDS, reliabilityApps } from "./computer-reliability-apps.ts";

const root = resolve(import.meta.dirname, "../../..");

describe("reliabilityApps", () => {
  it("defines the three apps, lightest first, each with a goal, files and checks", () => {
    const apps = reliabilityApps(root);
    expect(apps.map((app) => app.id)).toEqual([...RELIABILITY_APP_IDS]);
    expect(apps.map((app) => app.weight)).toEqual(["light", "medium", "heavy"]);
    for (const app of apps) {
      expect(app.goal.length).toBeGreaterThan(40);
      expect(Object.keys(app.checks).length).toBeGreaterThan(0);
      expect(Object.values(app.files).every((contents) => contents.length > 0)).toBe(true);
    }
  });

  it("shows each app's heading in its own source, which the preflight reads back", () => {
    for (const app of reliabilityApps(root))
      expect(Object.values(app.files).some((contents) => contents.includes(app.heading))).toBe(
        true,
      );
  });

  it("tests the correct specimens, never the planted bugs", () => {
    const [cart, notes] = reliabilityApps(root);
    expect(cart?.files["src/app.js"]).toContain("12 * Number(quantity.value)");
    // The buggy specimen writes a different key, so a reload loses the note.
    expect(notes?.files["src/app.js"]).toContain('localStorage.setItem("notes"');
  });
});
