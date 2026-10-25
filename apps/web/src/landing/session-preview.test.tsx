import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOKING_PROMPT, SessionPreview } from "./session-preview.tsx";

describe("the hero demo's sidebar preferences", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("does not restore the real app's saved session-list scroll", () => {
    sessionStorage.setItem("nap.sidebar.scroll", "640");
    const read = vi.spyOn(Storage.prototype, "getItem");
    render(<SessionPreview stage="ready" />);

    expect(read).not.toHaveBeenCalledWith("nap.sidebar.scroll");
    expect(screen.getByLabelText("Session list", { selector: "section" }).scrollTop).toBe(0);
  });

  it("keeps hero session-list scrolling out of the real app's saved scroll", () => {
    sessionStorage.setItem("nap.sidebar.scroll", "640");
    const write = vi.spyOn(Storage.prototype, "setItem");
    render(<SessionPreview stage="ready" />);
    const list = screen.getByLabelText("Session list", { selector: "section" });

    list.scrollTop = 120;
    fireEvent.scroll(list);

    expect(list.scrollTop).toBe(120);
    expect(write).not.toHaveBeenCalledWith("nap.sidebar.scroll", expect.anything());
    expect(sessionStorage.getItem("nap.sidebar.scroll")).toBe("640");
  });
});

describe("the landing session", () => {
  it("takes the prompt through a build to the interactive app", () => {
    const { rerender } = render(<SessionPreview stage="prompt" />);
    expect(screen.getByRole("log")).toHaveTextContent(BOOKING_PROMPT);
    expect(screen.queryByRole("button", { name: /reserve your quiet/i })).not.toBeInTheDocument();
    rerender(<SessionPreview stage="building" />);
    expect(screen.getByRole("log")).toHaveTextContent(/I'll build the booking page/);
    rerender(<SessionPreview stage="ready" />);
    fireEvent.click(screen.getByRole("button", { name: /reserve your quiet/i }));
    expect(screen.getByRole("status")).toHaveTextContent("Demo booking confirmed");
  });

  it("keeps the booking when switching between preview and code", () => {
    render(<SessionPreview stage="ready" />);
    fireEvent.click(screen.getByRole("button", { name: /reserve your quiet/i }));
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("status")).toHaveTextContent("Demo booking confirmed");
  });

  it("replays a finite build and lets a new scroll stage take control", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<SessionPreview stage="ready" />);
      fireEvent.click(screen.getByText("Replay the build"));
      expect(container.querySelector(".lp-session-shell")).toHaveAttribute("data-phase", "prompt");
      act(() => {
        vi.advanceTimersByTime(700);
      });
      expect(container.querySelector(".lp-session-shell")).toHaveAttribute(
        "data-phase",
        "building",
      );
      act(() => {
        vi.advanceTimersByTime(1100);
      });
      expect(screen.getByRole("button", { name: /reserve your quiet/i })).toBeInTheDocument();
      rerender(<SessionPreview stage="prompt" />);
      expect(container.querySelector(".lp-session-shell")).toHaveAttribute("data-phase", "prompt");
    } finally {
      vi.useRealTimers();
    }
  });
});
