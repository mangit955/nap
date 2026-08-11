import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Headline, sweep } from "./headline.tsx";

/**
 * The arrival and the sweep are motion and have no accessible surface — they are checked by eye.
 * What is worth pinning is what splitting a sentence into per-word spans can silently break: the
 * heading's accessible name, which is the only version of this sentence a screen reader gets.
 */

const LINES = ["Describe an app.", "Then go take a nap."] as const;
const SUB = "It'll be running by the time you're back.";

describe("Headline", () => {
  it("reads as one sentence, with the line break spoken as a space", () => {
    // A per-word span eats the whitespace around it if the space is left to the markup, and the
    // heading is then announced as "an app.Then go" — visually identical, and wrong.
    render(<Headline lines={LINES} sub={SUB} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Describe an app. Then go take a nap." }),
    ).toBeInTheDocument();
  });

  it("keeps the subheading as prose rather than as part of the heading", () => {
    render(<Headline lines={LINES} sub={SUB} />);

    expect(screen.getByText(SUB)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveTextContent(SUB);
  });

  it("staggers the words rather than starting them together", () => {
    render(<Headline lines={LINES} sub={SUB} />);

    const delays = [...screen.getByRole("heading", { level: 1 }).querySelectorAll("span span")].map(
      (word) => (word as HTMLElement).style.animationDelay,
    );

    expect(delays.length).toBe(8);
    expect(delays[0]).toBe("0ms");
    expect(new Set(delays).size).toBe(delays.length);
  });

  it("hands its element to the caller, and takes it back on unmount", () => {
    // The caller lights it from the card's pulse, and a stale element after a remount would be
    // swept forever while the one on screen never is.
    const onReady = vi.fn();
    const view = render(<Headline lines={LINES} sub={SUB} onReady={onReady} />);

    expect(onReady).toHaveBeenCalledWith(screen.getByRole("heading", { level: 1 }));

    view.unmount();
    expect(onReady).toHaveBeenLastCalledWith(null);
  });
});

describe("sweep", () => {
  it("restarts the animation by writing the attribute across two frames", () => {
    // Both writes in one frame are coalesced and nothing restarts — the same trap the rim light
    // is written around. Asserting only on the end state would pass against that version.
    vi.useFakeTimers();
    try {
      render(<Headline lines={LINES} sub={SUB} />);
      const heading = screen.getByRole("heading", { level: 1 });
      heading.dataset.sweeping = "true";

      sweep(heading);
      expect(heading.dataset.sweeping).toBe("false");

      vi.advanceTimersByTime(16);
      expect(heading.dataset.sweeping).toBe("false");

      vi.advanceTimersByTime(16);
      expect(heading.dataset.sweeping).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not light a heading that has gone", () => {
    vi.useFakeTimers();
    try {
      const view = render(<Headline lines={LINES} sub={SUB} />);
      const heading = screen.getByRole("heading", { level: 1 });

      sweep(heading);
      view.unmount();
      vi.advanceTimersByTime(50);

      expect(heading.dataset.sweeping).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op with nothing to light", () => {
    expect(() => sweep(null)).not.toThrow();
  });
});
