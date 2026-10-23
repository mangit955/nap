"use client";
import { getFiletypeFromFileName, preloadHighlighter } from "@pierre/diffs";
import { useEffect, useState } from "react";

export function usePierreHighlight(path: string, previousPath: string | null = null) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    let cancelled = false;
    void preloadHighlighter({
      themes: ["pierre-dark"],
      langs: [getFiletypeFromFileName(path), getFiletypeFromFileName(previousPath ?? path)],
      preferredHighlighter: "shiki-wasm",
    }).then(
      () => {
        if (!cancelled) setState("ready");
      },
      () => {
        if (!cancelled) setState("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, previousPath]);
  return state;
}
