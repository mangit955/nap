import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Workbench } from "./workbench.tsx";

/**
 * The right-hand panel: one of two things at a time, in a frame that keeps its place.
 *
 * The panel takes both halves as slots, so this proves the switching without mounting a socket,
 * a sandbox or a file listing.
 */

function show(tab: "preview" | "code") {
  return render(<Workbench tab={tab} preview={<p>the app</p>} code={<p>the files</p>} />);
}

describe("the workbench", () => {
  it("shows the preview on the preview tab", () => {
    show("preview");

    expect(screen.getByText("the app")).toBeVisible();
  });

  it("shows the code on the code tab", () => {
    show("code");

    expect(screen.getByText("the files")).toBeVisible();
  });

  it("keeps the preview mounted while the code is showing", () => {
    // **The one property worth a test here.** Unmounting the frame to show the files would
    // reload the user's app when they came back — losing whatever they had typed into it, and
    // costing a dev-server round trip every time somebody glanced at a file. It is hidden, not
    // discarded.
    const { rerender } = show("preview");
    const frame = screen.getByText("the app");

    rerender(<Workbench tab="code" preview={<p>the app</p>} code={<p>the files</p>} />);

    expect(screen.getByText("the app")).toBe(frame);
    expect(screen.getByText("the app")).not.toBeVisible();
  });

  it("names each panel by the tab that opens it", () => {
    // A tabpanel that is not associated with its tab is a region a screen reader cannot get to
    // from the tablist.
    show("preview");

    expect(screen.getByRole("tabpanel", { name: "Preview" })).toBeInTheDocument();
  });
});
