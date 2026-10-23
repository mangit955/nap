"use client";
import { Check, Copy, FileCode2, WrapText } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { type FetchJson, useFileContent } from "../files/use-project-files.ts";
import type { SessionLog } from "../hooks/use-session-log.ts";

const PierreFile = dynamic(() => import("./pierre-file.tsx"), {
  ssr: false,
  loading: () => <p className="t3-diff-notice">Loading file…</p>,
});
export function FilePanel({
  sessionId,
  path,
  log,
  fetchJson,
}: {
  sessionId: string | undefined;
  path: string;
  log: SessionLog;
  fetchJson?: FetchJson | undefined;
}) {
  const { file, status } = useFileContent({
    sessionId,
    path,
    events: log.events,
    ...(fetchJson ? { fetchJson } : {}),
  });
  const [wrap, setWrap] = useState(false);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const copyGeneration = useRef(0);
  useEffect(() => {
    void sessionId;
    void path;
    void file?.contents;
    copyGeneration.current++;
    setCopy("idle");
    return () => {
      copyGeneration.current++;
    };
  }, [sessionId, path, file?.contents]);
  const copyFile = async () => {
    if (!file) return;
    const generation = ++copyGeneration.current;
    try {
      await navigator.clipboard.writeText(file.contents);
      if (generation === copyGeneration.current) setCopy("copied");
    } catch {
      if (generation === copyGeneration.current) setCopy("failed");
    }
  };
  return (
    <section aria-label={`${path} (read-only)`} className="t3-file-panel">
      <div className="t3-file-toolbar">
        <FileCode2 size={14} />
        <span title={path}>{path}</span>
        <button
          type="button"
          aria-label="Wrap file lines"
          title="Wrap lines"
          aria-pressed={wrap}
          className="t3-icon-button"
          onClick={() => setWrap((value) => !value)}
        >
          <WrapText />
        </button>
        <button
          type="button"
          disabled={!file}
          aria-label={copy === "copied" ? "Copied file" : "Copy file"}
          title={copy === "copied" ? "Copied" : "Copy file"}
          className="t3-icon-button"
          onClick={() => void copyFile()}
        >
          {copy === "copied" ? <Check /> : <Copy />}
        </button>
      </div>
      {copy === "failed" && (
        <p role="alert" className="t3-diff-notice">
          Could not copy the file. Select its contents to copy manually.
        </p>
      )}
      <div className="t3-file-content nap-scroll">
        {file ? (
          <PierreFile path={path} contents={file.contents} wrap={wrap} />
        ) : (
          <div className="t3-panel-empty" role={status === "error" ? "alert" : "status"}>
            {status === "loading" ? "Loading file…" : "Could not read this file."}
          </div>
        )}
      </div>
      {file?.truncated && (
        <p className="t3-diff-notice">
          Showing the first part of this file. Full size: {file.bytes.toLocaleString()} bytes.
        </p>
      )}
    </section>
  );
}
