import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
  it("only Toaster imports Base UI's toast, so raising one stays free of it", () => {
    const src = join(import.meta.dirname, "..");
    const importers = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter((file) => readFileSync(join(src, file), "utf8").includes('"@base-ui/react/toast"'))
      .map((file) => relative(src, join(src, file)));
    expect(importers).toEqual(["ui/toast.tsx"]);
  });
});
