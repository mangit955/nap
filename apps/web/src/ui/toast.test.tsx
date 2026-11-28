import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Toaster } from "./toast.tsx";
import { showToast, subscribeToToasts } from "./toasts.ts";

describe("showToast and Toaster", () => {
  it("raised with no Toaster mounted, a toast is dropped without complaint", () => {
    expect(() => showToast({ title: "Nobody listening" })).not.toThrow();
    render(<Toaster />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("draws what was said, and reads an error out at once", async () => {
    render(<Toaster />);
    act(() => showToast({ title: "Branch copied", description: "nap/fix-header" }));
    const toast = await screen.findByRole("dialog", { name: "Branch copied" });
    expect(toast).toHaveAccessibleDescription("nap/fix-header");
    expect(screen.queryByRole("alert")).toBeNull();

    act(() => showToast({ title: "Could not copy", tone: "error" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy");
  });

  // jsdom neither applies Tailwind nor hit-tests, so this pins the class rather than the tap. On a
  // phone the stack covers the open sidebar's Settings and Help, and a toast that took pointer
  // events made both untappable until it went (seen in Chrome at 390px).
  it("lets taps through to whatever a toast covers", async () => {
    render(<Toaster />);
    act(() => showToast({ title: "Session link copied" }));
    const toast = await screen.findByRole("dialog", { name: "Session link copied" });
    expect(toast).toHaveClass("pointer-events-none");
    expect(screen.getByRole("region", { name: "Notifications" })).toHaveClass(
      "pointer-events-none",
    );
  });

  it("keeps an error up twice as long as a confirmation, since nothing pauses it", async () => {
    vi.useFakeTimers();
    try {
      render(<Toaster />);
      act(() => {
        showToast({ title: "Branch copied" });
        showToast({ title: "Could not copy", tone: "error" });
      });
      act(() => vi.advanceTimersByTime(5000));
      expect(screen.queryByRole("dialog", { name: "Branch copied" })).toBeNull();
      expect(screen.getByText("Could not copy", { selector: "h2" })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(3500));
      expect(screen.queryByText("Could not copy", { selector: "h2" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears what is showing at the next press anywhere, and only what is showing", async () => {
    render(<Toaster />);
    act(() => showToast({ title: "Session link copied" }));
    await screen.findByRole("dialog", { name: "Session link copied" });
    fireEvent.pointerDown(document.body);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Session link copied" })).toBeNull(),
    );
    act(() => showToast({ title: "Branch copied" }));
    expect(await screen.findByRole("dialog", { name: "Branch copied" })).toBeInTheDocument();
  });

  describe("a finished session's toast", () => {
    const finished = (onOpen = vi.fn()) => ({
      title: "Session finished",
      description: "Fix empty-state copy",
      tone: "finished" as const,
      action: { label: "Open", onClick: onOpen },
    });

    it("is announced politely, with Open and Dismiss as buttons a keyboard reaches", async () => {
      render(<Toaster />);
      act(() => showToast(finished()));
      const toast = await screen.findByRole("dialog", { name: "Session finished" });
      expect(toast).toHaveAccessibleDescription("Fix empty-state copy");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(document.querySelector('[aria-live="polite"]')).not.toBeNull();
      expect(screen.getByRole("button", { name: "Open" }).tabIndex).toBe(0);
      // Base UI hides the close button from a screen reader until the stack is hovered or holds
      // focus; tabbing to it is what a keyboard does, and that names it.
      const dismiss = screen.getByLabelText("Dismiss");
      expect(dismiss.tabIndex).toBe(0);
      act(() => dismiss.focus());
      expect(screen.getByRole("button", { name: "Dismiss" })).toHaveFocus();
    });

    it("runs its action and goes when Open is pressed", async () => {
      const onOpen = vi.fn();
      render(<Toaster />);
      act(() => showToast(finished(onOpen)));
      fireEvent.click(await screen.findByRole("button", { name: "Open" }));
      expect(onOpen).toHaveBeenCalledOnce();
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Session finished" })).toBeNull(),
      );
    });

    it("goes when dismissed, without running its action", async () => {
      const onOpen = vi.fn();
      render(<Toaster />);
      act(() => showToast(finished(onOpen)));
      fireEvent.click(await screen.findByLabelText("Dismiss"));
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Session finished" })).toBeNull(),
      );
      expect(onOpen).not.toHaveBeenCalled();
    });

    // It has something to press, so a press elsewhere is the reader carrying on, not a sign they
    // have read it — unlike a confirmation, which the next press clears.
    it("stays through a press elsewhere, which still clears a plain toast", async () => {
      render(<Toaster />);
      act(() => {
        showToast(finished());
        showToast({ title: "Branch copied" });
      });
      await screen.findByRole("dialog", { name: "Branch copied" });
      fireEvent.pointerDown(document.body);
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Branch copied" })).toBeNull(),
      );
      expect(screen.getByRole("dialog", { name: "Session finished" })).toBeInTheDocument();
    });
  });

  it("a listener stops hearing toasts once it unsubscribes", () => {
    const heard: string[] = [];
    const stop = subscribeToToasts(({ title }) => heard.push(title));
    showToast({ title: "Heard" });
    stop();
    showToast({ title: "Not heard" });
    expect(heard).toEqual(["Heard"]);
  });

  // Base UI's `Toast` is one namespace the bundler cannot split: any module that imports it
  // ships all of it. Measured in a production build, importing only its manager from the session
  // list put the toast's whole drawing code on the landing page, whose sidebar never shows one.
  // The package root is matched too: it re-exports the toast, and every other part with it.
  it("only Toaster imports Base UI's toast, so raising one stays free of it", () => {
    const src = join(import.meta.dirname, "..");
    const importers = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter((file) =>
        /["']@base-ui\/react(?:\/toast)?["']/.test(readFileSync(join(src, file), "utf8")),
      )
      .map((file) => relative(src, join(src, file)));
    expect(importers).toEqual(["ui/toast.tsx"]);
  });

  // Kept apart from the line above: moving `showToast` into `ui/toast.tsx` would leave Base UI's
  // import where it is and still put the drawing code on the landing page, through the sidebar.
  it("only the dashboard's frame imports Toaster, which is what draws a toast", () => {
    const src = join(import.meta.dirname, "..");
    const importers = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter((file) =>
        /from\s+["'][^"']*\/toast\.tsx["']/.test(readFileSync(join(src, file), "utf8")),
      )
      .map((file) => relative(src, join(src, file)));
    expect(importers).toEqual(["dashboard/dashboard.tsx"]);
  });
});
