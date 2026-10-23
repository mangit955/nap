import type { FileDiffMetadata } from "@pierre/diffs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DiffFile } from "./changes-panel.tsx";
import PierrePatch from "./pierre-patch.tsx";

// Keep the actual parser; only the browser highlighter and shadow-DOM renderer are replaced.
vi.mock("./use-pierre-highlight.ts", () => ({ usePierreHighlight: () => "ready" }));
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: { fileDiff: FileDiffMetadata }) => (
    <section aria-label="Highlighted patch">
      <pre>
        {fileDiff.deletionLines.join("")}
        {fileDiff.additionLines.join("")}
      </pre>
    </section>
  ),
}));
vi.mock("next/dynamic", async () => {
  const { default: Patch } = await import("./pierre-patch.tsx");
  return { default: () => Patch };
});

const valid = "@@ -1 +1 @@\n-before sentinel\n+after sentinel\n";
const header = "diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n";
const malformed = "@@ malformed fixture patch @@\n+raw fallback sentinel";
const unsupported = "@@unsupported header\n+raw fallback sentinel";
const combined = "@@@ -1,1 -1,1 +1,1 @@@\n++combined fallback sentinel";

describe("patch parser integration", () => {
  it.each([
    malformed,
    header + malformed,
    valid + malformed,
    unsupported,
    "@@ -1 +1 @@\nunsupported body sentinel\n+after sentinel\n",
  ])("preserves the entire unsupported patch in the raw fallback: %s", (patch) => {
    const { container } = render(
      <PierrePatch patch={patch} path="app.ts" previousPath={null} split={false} />,
    );
    expect(container.querySelector(".t3-raw-patch")?.textContent).toBe(patch);
    expect(screen.getByText(/Showing the raw patch/)).toBeVisible();
    expect(screen.queryByLabelText("Highlighted patch")).not.toBeInTheDocument();
  });

  it.each([
    { name: "unsupported suffix", patch: valid + unsupported },
    { name: "unsupported suffix with file headers", patch: header + valid + unsupported },
    { name: "unsupported prefix", patch: `${unsupported}\n${valid}` },
    { name: "unsupported prefix with file headers", patch: `${header}${unsupported}\n${valid}` },
    { name: "combined suffix", patch: valid + combined },
    { name: "combined prefix", patch: `${combined}\n${valid}` },
  ])("preserves the entire mixed patch with $name", ({ patch }) => {
    const { container } = render(
      <PierrePatch patch={patch} path="app.ts" previousPath={null} split={false} />,
    );
    expect(container.querySelector(".t3-raw-patch")?.textContent).toBe(patch);
    expect(screen.getByText(/Showing the raw patch/)).toBeVisible();
    expect(screen.queryByLabelText("Highlighted patch")).not.toBeInTheDocument();
  });

  it.each([valid, header + valid])(
    "keeps complete valid hunks on the highlighted path: %s",
    (patch) => {
      const { container } = render(
        <PierrePatch patch={patch} path="app.ts" previousPath={null} split />,
      );
      const highlighted = screen.getByLabelText("Highlighted patch");
      expect(highlighted).toHaveTextContent("before sentinel");
      expect(highlighted).toHaveTextContent("after sentinel");
      expect(highlighted.textContent).toBe("before sentinel\nafter sentinel\n");
      expect(container.querySelector(".t3-raw-patch")).toBeNull();
    },
  );

  it.each([
    {
      name: "multiple complete hunks",
      patch: `${header}${valid}@@ -3 +3 @@\n-second before\n+second after\n`,
      text: "before sentinel\nsecond before\nafter sentinel\nsecond after\n",
    },
    {
      name: "marker-like content with body prefixes and hunk context",
      patch:
        "@@ -1,2 +1,2 @@ @@function context\n @@context sentinel\n-@@removed sentinel\n+@@@added sentinel\n",
      text: "@@context sentinel\n@@removed sentinel\n@@context sentinel\n@@@added sentinel\n",
    },
  ])("keeps $name highlighted with exact parsed content", ({ patch, text }) => {
    const { container } = render(
      <PierrePatch patch={patch} path="app.ts" previousPath={null} split={false} />,
    );
    expect(screen.getByLabelText("Highlighted patch").textContent).toBe(text);
    expect(container.querySelector(".t3-raw-patch")).toBeNull();
    expect(screen.queryByText(/Showing the raw patch/)).not.toBeInTheDocument();
  });

  it.each([
    "@@ -1,3 +1,3 @@\n retained context\n-before sentinel\n+after sentinel\n",
    "@@ -1,3 +1,3 @@\n",
  ])("preserves clipped hunk text and the truncation notice: %s", (patch) => {
    const { container } = render(
      <DiffFile
        file={{
          path: "app.ts",
          previousPath: null,
          status: "modified",
          additions: 1,
          deletions: 1,
          binary: false,
          truncated: true,
          patch,
        }}
        split={false}
      />,
    );
    expect(container.querySelector(".t3-raw-patch")?.textContent).toBe(patch);
    expect(screen.getByText(/Patch truncated/)).toBeVisible();
  });

  it.each([
    {
      patch: "diff --git a/app.ts b/app.ts\nold mode 100644\nnew mode 100755\n",
      status: "modified",
      previousPath: null,
      binary: false,
      truncated: false,
      notice: "No text changes",
    },
    {
      patch:
        "diff --git a/old.ts b/app.ts\nsimilarity index 100%\nrename from old.ts\nrename to app.ts\n",
      status: "renamed",
      previousPath: "old.ts",
      binary: false,
      truncated: false,
      notice: "Renamed from old.ts",
    },
    {
      patch: "diff --git a/app.ts b/app.ts\nBinary files a/app.ts and b/app.ts differ\n",
      status: "modified",
      previousPath: null,
      binary: true,
      truncated: false,
      notice: "Binary file changed",
    },
    {
      patch: "",
      status: "modified",
      previousPath: null,
      binary: false,
      truncated: true,
      notice: "Patch unavailable or omitted because this comparison exceeds the display limit.",
    },
  ] as const)("retains the existing $notice notice", ({ notice, ...file }) => {
    const { container } = render(
      <DiffFile file={{ ...file, path: "app.ts", additions: 0, deletions: 0 }} split={false} />,
    );
    expect(screen.getByText(notice)).toBeVisible();
    expect(container.querySelector(".t3-raw-patch")).toBeNull();
    expect(screen.queryByLabelText("Highlighted patch")).not.toBeInTheDocument();
  });
});
