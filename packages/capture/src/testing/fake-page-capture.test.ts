import { describe, expect, it } from "vitest";
import { FakePageCapture } from "./fake-page-capture.ts";

/**
 * The fake every test above this port depends on, so it is checked like production code.
 */

describe("the fake page capture", () => {
  it("records what it was asked for", async () => {
    const capture = new FakePageCapture();

    await capture.capture("https://preview.example/", { width: 800, height: 500 });

    expect(capture.requests).toEqual([
      { url: "https://preview.example/", options: { width: 800, height: 500 } },
    ]);
  });

  it("hands back a copy, so one reader cannot corrupt the next", async () => {
    const capture = new FakePageCapture().returning(new Uint8Array([1, 2, 3]));

    const first = await capture.capture("https://preview.example/");
    if (first.ok) first.value.fill(0);
    const second = await capture.capture("https://preview.example/");

    expect(second.ok && [...second.value]).toEqual([1, 2, 3]);
  });

  it("fails on demand, and stops failing", async () => {
    const capture = new FakePageCapture().failWith({ code: "timeout", message: "too slow" });

    expect(await capture.capture("https://preview.example/")).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });

    capture.failWith(undefined);
    expect((await capture.capture("https://preview.example/")).ok).toBe(true);
  });
});
