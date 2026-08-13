import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Starting a project from a sentence, which two pages now do — the landing hero and the
 * dashboard's composer.
 *
 * A `.tsx` with barely any JSX in it: the filename is what routes a test to the project with a
 * DOM, and a hook test named `.test.ts` runs in Node and fails on `sessionStorage`.
 *
 * The router is mocked at the module boundary the way `live-sign-in.test.tsx` does it; `fetch`
 * comes in through an argument, so every branch is reachable without a network.
 */

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

const { takeFirstPrompt } = await import("../chat/first-prompt.ts");
const { useStartProject } = await import("./use-start-project.ts");

const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const SESSION = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";

type Started = ReturnType<typeof useStartProject>;

/** Renders the hook and hands its latest return value back through a box the test can read. */
function mount(fetchJson: (url: string, init?: RequestInit) => Promise<Response>) {
  const box: { current: Started | undefined } = { current: undefined };

  function Probe() {
    box.current = useStartProject({ fetchJson, baseUrl: "http://api.test" });
    return null;
  }

  render(<Probe />);
  return box as { current: Started };
}

const created = () =>
  new Response(JSON.stringify({ projectId: PROJECT, sessionId: SESSION }), { status: 201 });

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

describe("starting a project from a prompt", () => {
  it("creates one, writes the prompt down for it, and opens it", async () => {
    const fetchJson = vi.fn().mockResolvedValue(created());
    const box = mount(fetchJson);

    await act(async () => {
      await box.current.start("a habit tracker");
    });

    expect(fetchJson).toHaveBeenCalledWith(
      "http://api.test/projects",
      expect.objectContaining({ method: "POST" }),
    );
    // The workspace is where the turn is actually sent, so the sentence has to survive the trip.
    expect(takeFirstPrompt(PROJECT)).toEqual({ text: "a habit tracker" });
    expect(push).toHaveBeenCalledWith(`/p/${PROJECT}`);
  });

  it("stays busy while it is on its way out, so nothing is sent twice", async () => {
    // Re-enabling the box during the navigation is how a second press makes a second project.
    const fetchJson = vi.fn().mockResolvedValue(created());
    const box = mount(fetchJson);

    await act(async () => {
      await box.current.start("a habit tracker");
    });

    expect(box.current.busy).toBe(true);
  });

  it("repeats the server's own explanation when it refuses", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "you have too many projects open" }), { status: 429 }),
      );
    const box = mount(fetchJson);

    await act(async () => {
      await box.current.start("a habit tracker");
    });

    expect(box.current.error).toBe("you have too many projects open");
    expect(box.current.busy).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it("says something usable when the server is unreachable", async () => {
    const fetchJson = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const box = mount(fetchJson);

    await act(async () => {
      await box.current.start("a habit tracker");
    });

    expect(box.current.error).toMatch(/could not/i);
    expect(box.current.busy).toBe(false);
  });

  it("sends nothing for an empty sentence", async () => {
    const fetchJson = vi.fn().mockResolvedValue(created());
    const box = mount(fetchJson);

    await act(async () => {
      await box.current.start("   ");
    });

    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("carries an explicit model into the first prompt", async () => {
    const fetchJson = vi.fn().mockResolvedValue(created());
    const box = mount(fetchJson);

    await act(async () => {
      await box.current.start("a habit tracker", "anthropic/claude-opus-5");
    });

    expect(takeFirstPrompt(PROJECT)).toEqual({
      text: "a habit tracker",
      model: "anthropic/claude-opus-5",
    });
  });
});
