"use client";
import { Check, Copy, FileCode2, WrapText } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
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
  // A copy result remembers which file and contents it was for, and only shows while those are
  // still on screen. Resetting it from an effect instead lost a click that landed between the
  // commit showing new contents and that effect running: the late reset wiped the result.
  const [copyResult, setCopyResult] = useState<{
    status: "copied" | "failed";
    sessionId: string | undefined;
    path: string;
    contents: string;
  }>();
  const copy =
    copyResult &&
    file &&
    copyResult.sessionId === sessionId &&
    copyResult.path === path &&
    copyResult.contents === file.contents
      ? copyResult.status
      : "idle";
  const copyFile = async () => {
    if (!file) return;
    const target = { sessionId, path, contents: file.contents };
    try {
      await navigator.clipboard.writeText(target.contents);
      setCopyResult({ status: "copied", ...target });
    } catch {
      setCopyResult({ status: "failed", ...target });
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
