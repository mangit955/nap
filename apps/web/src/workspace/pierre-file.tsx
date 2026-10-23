"use client";
import { File } from "@pierre/diffs/react";
import { useMemo } from "react";
import { DIFF_THEME_CSS } from "./diff-theme.ts";
import { usePierreHighlight } from "./use-pierre-highlight.ts";
export default function PierreFile({
  path,
  contents,
  wrap,
}: {
  path: string;
  contents: string;
  wrap: boolean;
}) {
  const state = usePierreHighlight(path);
  const file = useMemo(() => ({ name: path, contents }), [path, contents]);
  if (state === "loading") return <p className="t3-diff-notice">Loading file…</p>;
  if (state === "failed") return <pre className="t3-raw-patch">{contents}</pre>;
  return (
    <File
      file={file}
      options={{
        theme: "pierre-dark",
        themeType: "dark",
        preferredHighlighter: "shiki-wasm",
        disableFileHeader: true,
        overflow: wrap ? "wrap" : "scroll",
        unsafeCSS: DIFF_THEME_CSS,
      }}
    />
  );
}
