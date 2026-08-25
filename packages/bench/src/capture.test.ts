/**
 * The deliberate capture pass, against the scripted browser — no Chrome anywhere.
 *
 * That is the property the whole design of `surface.ts` is for: the steps that reach a surface
 * are the same declarative vocabulary a check uses, so the pass is drivable by a fake.
 */

import { describe, expect, it } from "vitest";
import { runCapturePass } from "./capture.ts";
import type { CapturedScreenshot, ScreenshotStore } from "./screenshot.ts";
import { screenshotFilename } from "./screenshot.ts";
import type { SurfaceCapture } from "./surface.ts";
import {
  ScriptedBrowserSession,
  type ScriptedBrowserSessionOptions,
} from "./testing/scripted-browser-session.ts";

const RUN_ID = "3f2a1c4e-0000-4000-8000-000000000001";
const CAPTURED_AT = "2026-08-15T04:05:06.000Z";
const BASE_URL = "https://preview.example";

function recordingStore() {
  const saved: CapturedScreenshot[] = [];
  const store: ScreenshotStore = async (screenshot) => {
    saved.push(screenshot);
    return { ok: true, value: screenshotFilename(screenshot.metadata) };
  };
  return { store, saved };
}

/** A fresh session per call, as the real factory gives, with the sessions kept for assertions. */
function browserFactory(options: ScriptedBrowserSessionOptions = {}) {
  const sessions: ScriptedBrowserSession[] = [];
  const factory = async () => {
    const session = new ScriptedBrowserSession({
      pages: {
        "/": { elements: [{ text: "Todos" }, { role: "button", name: "Add" }] },
      },
      ...options,
    });
    sessions.push(session);
    return { ok: true as const, value: session };
  };
  return { factory, sessions };
}

const pair: SurfaceCapture[] = [
  { surfaceId: "home", viewport: "mobile", steps: [] },
  { surfaceId: "home", viewport: "desktop", steps: [] },
];

function pass(overrides: Partial<Parameters<typeof runCapturePass>[0]> = {}) {
  const { store } = recordingStore();
  const { factory } = browserFactory();
  return {
    plan: pair,
    baseUrl: BASE_URL,
    browser: factory,
    store,
    taskId: "todo",
    runId: RUN_ID,
    now: () => new Date(CAPTURED_AT),
    ...overrides,
  };
}

describe("runCapturePass", () => {
  it("photographs each planned surface, labelled with the surface and the size asked for", async () => {
    const { store, saved } = recordingStore();

    const refs = await runCapturePass(pass({ store }));

    expect(saved).toHaveLength(2);
    expect(refs).toEqual([
      {
        checkId: null,
        surface: { id: "home", viewport: "mobile" },
        viewport: { name: "mobile", width: 375, height: 667 },
        path: `todo-${RUN_ID}-surface@home@mobile.png`,
        capturedAt: CAPTURED_AT,
      },
      {
        checkId: null,
        surface: { id: "home", viewport: "desktop" },
        viewport: { name: "desktop", width: 1280, height: 800 },
        path: `todo-${RUN_ID}-surface@home@desktop.png`,
        capturedAt: CAPTURED_AT,
      },
    ]);
  });

  it("hands a judge a like-for-like pair: one surface, two sizes, nothing else differing", async () => {
    const refs = await runCapturePass(pass());

    expect(refs.map((ref) => ref.surface?.id)).toEqual(["home", "home"]);
    expect(refs.map((ref) => ref.viewport.width)).toEqual([375, 1280]);
  });

  it("performs the steps that reach the surface before photographing it", async () => {
    const { factory, sessions } = browserFactory({
      on: {
        click: ({ page }) => {
          page.add({ text: "Buy milk" });
        },
      },
    });
    const plan: SurfaceCapture[] = [
      {
        surfaceId: "populated",
        viewport: "mobile",
        steps: [{ step: "click", selector: { by: "role", role: "button", name: "Add" } }],
      },
    ];

    await runCapturePass(pass({ plan, browser: factory }));

    // The click landed before the photograph, which is the whole point of a surface having steps.
    expect(sessions[0]?.calls.map((call) => call.method)).toEqual([
      "setViewport",
      "goto",
      "click",
      "screenshot",
      "close",
    ]);
  });

  it("opens a session per photograph, so one surface cannot leak into the next", async () => {
    const { factory, sessions } = browserFactory();

    await runCapturePass(pass({ browser: factory }));

    expect(sessions).toHaveLength(2);
  });

  it("closes every session, including one whose surface could not be reached", async () => {
    const { factory, sessions } = browserFactory();
    const plan: SurfaceCapture[] = [
      { surfaceId: "missing", viewport: "mobile", steps: [{ step: "navigate", path: "/nowhere" }] },
    ];

    await runCapturePass(pass({ plan, browser: factory }));

    expect(sessions[0]?.calls.at(-1)?.method).toBe("close");
  });

  it("carries on past a surface it could not reach, and keeps the ones it could", async () => {
    // One unreachable view is one missing image, not a pass that gives up: the next surface may
    // be perfectly reachable, and a judge with one image is better off than a judge with none.
    const plan: SurfaceCapture[] = [
      { surfaceId: "missing", viewport: "mobile", steps: [{ step: "navigate", path: "/nowhere" }] },
      { surfaceId: "home", viewport: "desktop", steps: [] },
    ];

    const refs = await runCapturePass(pass({ plan }));

    expect(refs.map((ref) => ref.surface?.id)).toEqual(["home"]);
  });

  it("stops asking when there is no browser to ask", async () => {
    // An economy rather than a judgement: every remaining entry would pay the same timeout to
    // hear the same answer from the same absent browser.
    let asked = 0;
    const browser = async () => {
      asked += 1;
      return { ok: false as const, error: { code: "unavailable" as const, message: "no chrome" } };
    };

    const refs = await runCapturePass(pass({ browser }));

    expect(refs).toEqual([]);
    expect(asked).toBe(1);
  });

  it("loses the image rather than the run when a screenshot cannot be stored", async () => {
    const failing: ScreenshotStore = async () => ({ ok: false, error: "no space left on device" });

    await expect(runCapturePass(pass({ store: failing }))).resolves.toEqual([]);
  });

  it("loses the image rather than the run when the browser will not photograph", async () => {
    const { factory } = browserFactory({
      fail: (call) =>
        call.method === "screenshot"
          ? { code: "action_failed", message: "the page would not render" }
          : undefined,
    });

    await expect(runCapturePass(pass({ browser: factory }))).resolves.toEqual([]);
  });

  it("takes nothing at all for an empty plan", async () => {
    await expect(runCapturePass(pass({ plan: [] }))).resolves.toEqual([]);
  });
});
