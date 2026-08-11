import { describe, expect, it } from "vitest";
import { pathForMode } from "./mode-path.ts";

describe("pathForMode", () => {
  it("sends each half of the form to its own URL", () => {
    // One address per mode is the whole point: the address bar is corrected to this as the form
    // switches, so a mapping that answered the same thing twice would leave a reload landing on
    // the opposite half of the form from the one on screen.
    expect(pathForMode("sign-in")).toBe("/sign-in");
    expect(pathForMode("sign-up")).toBe("/sign-up");
    expect(pathForMode("sign-in")).not.toBe(pathForMode("sign-up"));
  });
});
