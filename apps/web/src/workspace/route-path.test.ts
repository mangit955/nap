import { describe, expect, it } from "vitest";
import { normaliseRoute, previewUrlFor } from "./route-path.ts";

/**
 * The route box in the top bar: where to send the preview frame.
 *
 * It says where the frame is being *sent*, never where it is — the frame is cross-origin, so
 * nothing on this side can ask it what page it is on. That is a limitation of the medium rather
 * than of this function, and the reason the field is not called an address bar.
 */

const BASE = "https://5173-abc.e2b.app";

describe("normalising what was typed", () => {
  it("adds the leading slash people leave out", () => {
    expect(normaliseRoute("pricing")).toBe("/pricing");
  });

  it("collapses a doubled slash rather than making a protocol-relative URL", () => {
    // `//evil.example` is a URL to another *host*, not a path — the one input here that could
    // send somebody's frame somewhere else entirely.
    expect(normaliseRoute("//pricing")).toBe("/pricing");
  });

  it("keeps a path that was already right", () => {
    expect(normaliseRoute("/about/team")).toBe("/about/team");
  });

  it("keeps a query and a fragment, which are part of where you meant", () => {
    expect(normaliseRoute("/search?q=nap#top")).toBe("/search?q=nap#top");
  });

  it("trims what a paste brings with it", () => {
    expect(normaliseRoute("  /pricing  ")).toBe("/pricing");
  });

  it("treats an empty box as the root", () => {
    expect(normaliseRoute("")).toBe("/");
    expect(normaliseRoute("   ")).toBe("/");
  });

  it("refuses an absolute URL", () => {
    // The box addresses the running app. A whole URL here would point the frame at somebody
    // else's site while the bar still said it was showing this project.
    expect(normaliseRoute("https://example.com/pricing")).toBe("/pricing");
    expect(normaliseRoute("javascript:alert(1)")).toBe("/");
  });
});

describe("the address the frame is given", () => {
  it("is the sandbox's own, with the route on the end", () => {
    expect(previewUrlFor(BASE, "/pricing")).toBe("https://5173-abc.e2b.app/pricing");
  });

  it("does not double the slash when the sandbox URL ends in one", () => {
    expect(previewUrlFor(`${BASE}/`, "/pricing")).toBe("https://5173-abc.e2b.app/pricing");
  });

  it("is the sandbox's own, unchanged, for the root", () => {
    // Not `base + "/"`: the frame is keyed on this string, and a cosmetic difference between
    // the default and somebody typing `/` would reload the user's app for nothing.
    expect(previewUrlFor(BASE, "/")).toBe("https://5173-abc.e2b.app");
    expect(previewUrlFor(`${BASE}/`, "/")).toBe("https://5173-abc.e2b.app");
  });

  it("normalises on the way through, so one call is enough", () => {
    expect(previewUrlFor(BASE, "pricing")).toBe("https://5173-abc.e2b.app/pricing");
  });
});
