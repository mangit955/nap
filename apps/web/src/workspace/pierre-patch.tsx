"use client";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";
import { DIFF_THEME_CSS } from "./diff-theme.ts";
import { usePierreHighlight } from "./use-pierre-highlight.ts";

export default function PierrePatch({
  patch,
  path,
  previousPath,
  split,
}: {
  patch: string;
  path: string;
  previousPath: string | null;
  split: boolean;
}) {
  const highlight = usePierreHighlight(path, previousPath);
  const parsed = useMemo(() => {
    // Even strict parsing can ignore markers without the "@@ " delimiter.
    // Body content starts with +, - or space, so it cannot match this guard.
    if (/^@@(?! )/m.test(patch)) return [];
    try {
      const source = patch.startsWith("@@")
        ? `diff --git ${JSON.stringify(`a/${previousPath ?? path}`)} ${JSON.stringify(`b/${path}`)}\n--- ${JSON.stringify(`a/${previousPath ?? path}`)}\n+++ ${JSON.stringify(`b/${path}`)}\n${patch}\n`
        : patch;
      // Tolerant parsing can silently discard unsupported hunks. Count-mismatched
      // clipped hunks also use the raw view so every retained line stays readable.
      return parsePatchFiles(source, undefined, true).flatMap((item) => item.files);
    } catch {
      return [];
    }
  }, [patch, path, previousPath]);
  if (highlight === "loading") return <p className="t3-diff-notice">Loading diff…</p>;
  if (
    parsed.length === 0 ||
    parsed.some((file) => file.hunks.length === 0) ||
    highlight === "failed"
  )
    return (
      <>
        <p className="t3-diff-notice">
          Showing the raw patch because this patch is incomplete or unsupported.
        </p>
        <pre className="t3-raw-patch">{patch}</pre>
      </>
    );
  return (
    <>
      {parsed.map((file) => (
        <FileDiff
          key={file.name}
          fileDiff={file}
          options={{
            theme: "pierre-dark",
            preferredHighlighter: "shiki-wasm",
            themeType: "dark",
            diffStyle: split ? "split" : "unified",
            diffIndicators: "classic",
            disableFileHeader: true,
            overflow: "scroll",
            hunkSeparators: "line-info",
            unsafeCSS: DIFF_THEME_CSS,
          }}
        />
      ))}
    </>
  );
}
