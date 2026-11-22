import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInput } from "../chat/chat-input.tsx";
import {
  CLAIM_WITHIN_MS,
  departFrom,
  forgetSendGlide,
  GLIDE_MS,
  glideOffset,
} from "./send-glide.ts";
import { WorkspacePanes } from "./workspace-panes.tsx";

/**
 * The glide from the dashboard into the workspace. jsdom lays nothing out and runs no animations,
 * so these pin what the frame asks of the browser — which elements move, from where, and at what
 * point of the glide — and leave how it looks to the screencast in the PR.
 */

type Call = { element: Element; keyframes: Keyframe[]; timing: KeyframeAnimationOptions };
const calls: Call[] = [];
const cancelled: Element[] = [];
const realAnimate = Element.prototype.animate;
const realMatchMedia = window.matchMedia;
let now = 10_000;
let reduce = false;

beforeEach(() => {
  now = 10_000;
  reduce = false;
  calls.length = 0;
  cancelled.length = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  Element.prototype.animate = function animate(keyframes, timing) {
    calls.push({
      element: this,
      keyframes: keyframes as Keyframe[],
      timing: timing as KeyframeAnimationOptions,
    });
    return {
      cancel: () => {
        cancelled.push(this);
      },
    } as Animation;
  };
  window.matchMedia = ((query: string) => ({
    matches: query.includes("reduce") && reduce,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

afterEach(() => {
  forgetSendGlide();
  vi.restoreAllMocks();
  Element.prototype.animate = realAnimate;
  window.matchMedia = realMatchMedia;
});

/** A composer on the dashboard at this box, sent now. */
function send(box: { left: number; top: number; right: number; bottom: number }) {
  const composer = document.createElement("fieldset");
  composer.getBoundingClientRect = () =>
    DOMRect.fromRect({
      x: box.left,
      y: box.top,
      width: box.right - box.left,
      height: box.bottom - box.top,
    });
  departFrom(composer);
}

/** The workspace as both its starting view and the project's own draw it, at jsdom's zero box. */
function Workspace() {
  return (
    <WorkspacePanes
      panelOpen
      maximized={false}
      chatHidden={false}
      onDismissPanel={() => {}}
      chat={
        <>
          <div className="chat-user-message" data-turn-prompt="">
            Build a calendar
          </div>
          <div className="chat-composer-dock">
            <div className="workspace-composer" role="status">
              Starting your project…
            </div>
          </div>
        </>
      }
      workbench={<section className="t3-workbench" aria-label="Right panel" />}
    />
  );
}

const moved = (selector: string) => calls.filter((call) => call.element.matches(selector));

describe("the glide into the workspace", () => {
  it("moves the composer from where it was sent, and eases in the prompt and the right panel", () => {
    send({ left: 100, top: 50, right: 500, bottom: 250 });
    render(<Workspace />);

    const [composer] = moved(".workspace-composer");
    // Centred across (300 against 0) and level at the bottom (250 against 0).
    expect(composer?.keyframes).toEqual([
      { transform: "translate(300px, 250px)" },
      { transform: "none" },
    ]);
    expect(composer?.timing).toMatchObject({ duration: GLIDE_MS, delay: 0 });
    expect(moved("[data-turn-prompt]")).toHaveLength(1);
    expect(moved(".t3-workbench")).toHaveLength(1);
    // Held invisible until each starts, so nothing shows, vanishes and fades back.
    for (const call of calls) expect(call.timing.fill).toBe("backwards");
  });

  it("carries on from the same point when the starting view hands over to the project's", () => {
    send({ left: 100, top: 50, right: 500, bottom: 250 });
    now += 40;
    const starting = render(<Workspace />);
    now += 120;
    starting.unmount();
    // A start the server refused unmounts the same way, and nothing it moved stays moved.
    expect(cancelled).toHaveLength(3);
    calls.length = 0;
    render(<Workspace />);

    const [composer] = moved(".workspace-composer");
    expect(composer?.keyframes[0]).toEqual({ transform: "translate(300px, 250px)" });
    expect(composer?.timing.delay).toBe(-120);
  });

  it("plays once, so coming back to the project later does not move it again", () => {
    send({ left: 100, top: 50, right: 500, bottom: 250 });
    render(<Workspace />).unmount();
    now += GLIDE_MS;
    calls.length = 0;
    // Back to the dashboard and Forward into the project, or a switch from the sidebar.
    render(<Workspace />);
    expect(calls).toEqual([]);
  });

  it("cuts to a workspace that took too long to arrive", () => {
    send({ left: 100, top: 50, right: 500, bottom: 250 });
    now += CLAIM_WITHIN_MS + 1;
    render(<Workspace />);
    expect(calls).toEqual([]);
  });

  it("cuts for somebody who asked for reduced motion, through the handover too", () => {
    reduce = true;
    send({ left: 100, top: 50, right: 500, bottom: 250 });
    render(<Workspace />).unmount();
    now += 100;
    render(<Workspace />);
    expect(calls).toEqual([]);
  });

  it("moves nothing in a workspace opened without a send", () => {
    render(<Workspace />);
    expect(calls).toEqual([]);
  });

  it("never moves the composer the landing page's demos draw", () => {
    // The demos draw `ChatInput` with no workspace frame around it.
    send({ left: 100, top: 50, right: 500, bottom: 250 });
    render(<ChatInput running={false} error={undefined} onSubmit={() => {}} onCancel={() => {}} />);
    expect(calls).toEqual([]);
  });
});

describe("where the glide starts", () => {
  const to = { left: 200, top: 700, right: 800, bottom: 820 };

  it("centres the composer across and levels it at the bottom", () => {
    expect(glideOffset({ left: 300, top: 300, right: 1100, bottom: 460 }, to, [])).toEqual({
      x: 200,
      y: -360,
    });
  });

  it("keeps the moved composer inside every box that clips it", () => {
    const column = { left: 180, top: 0, right: 820, bottom: 900 };
    const header = { left: 0, top: 400, right: 1440, bottom: 900 };
    // Wanted: 200 right and 360 up. The column leaves 20 to the right; the second box 300 up.
    expect(
      glideOffset({ left: 300, top: 300, right: 1100, bottom: 460 }, to, [column, header]),
    ).toEqual({
      x: 20,
      y: -300,
    });
  });

  it("does not move across a box narrower than the composer", () => {
    const narrow = { left: 300, top: 0, right: 700, bottom: 900 };
    expect(glideOffset({ left: 300, top: 300, right: 1100, bottom: 460 }, to, [narrow]).x).toBe(0);
  });
});
