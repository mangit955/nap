"use client";

/**
 * One file, read-only.
 *
 * A panel over the workspace rather than a fifth column: the file list is 260px wide, which
 * is unreadable for source, and a viewer that pushed the preview aside would make looking at
 * a file cost the thing the user is actually building.
 *
 * Not modal. The tree stays clickable underneath so files can be flipped through, which is
 * why there is no focus trap — but Escape still closes it, because a panel covering the app
 * that only a small button dismisses is a trap for anyone on a keyboard.
 *
 * Highlighting is the one thing here with no accessible surface: it is colour, and a screen
 * reader is told nothing about it. So the markup carries the file on its own terms — one
 * element per line, with the line number as text — and Prism decorates it.
 */

import type { FileContent } from "@nap/shared/files-protocol";
import { Highlight, type PrismTheme } from "prism-react-renderer";
import { useEffect } from "react";
import type { LoadStatus } from "./use-project-files.ts";

/** Extensions to Prism's language names. Anything absent renders as plain text. */
const LANGUAGES: Record<string, string> = {
  tsx: "tsx",
  ts: "typescript",
  jsx: "jsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  html: "markup",
  svg: "markup",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
};

function languageOf(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return LANGUAGES[extension] ?? "text";
}

/**
 * The palette from `globals.css`, as Prism expects it.
 *
 * A bundled theme would bring its own set of colours into a frame built from six, and the
 * file panel would be the one surface in the app that looks like somewhere else.
 */
const THEME: PrismTheme = {
  plain: { color: "#e8e8ee", backgroundColor: "transparent" },
  styles: [
    { types: ["comment", "prolog", "doctype", "cdata"], style: { color: "#5a5a68" } },
    { types: ["punctuation", "operator"], style: { color: "#8b8b99" } },
    { types: ["string", "attr-value", "char", "inserted"], style: { color: "#8fd18b" } },
    { types: ["number", "boolean", "constant", "symbol"], style: { color: "#d4a76a" } },
    { types: ["keyword", "atrule", "selector", "deleted"], style: { color: "#a48cff" } },
    { types: ["function", "class-name"], style: { color: "#7fc7ff" } },
    { types: ["tag", "builtin"], style: { color: "#e05561" } },
    { types: ["attr-name", "property", "variable"], style: { color: "#e8e8ee" } },
  ],
};

export function FileViewer({
  path,
  file,
  status,
  onClose,
}: {
  path: string;
  file: FileContent | undefined;
  status: LoadStatus;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    // A named region rather than a dialog: it sits beside the tree in the Code tab now, and
    // nothing about it is modal — the tree stays usable while a file is open, which is the whole
    // reason for showing them side by side.
    <section
      aria-label={`${path} (read-only)`}
      className="flex min-h-0 min-w-0 flex-1 flex-col border-edge border-l"
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-edge border-b px-4">
        <span className="truncate font-mono text-ink text-xs">{path}</span>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded border border-edge px-1.5 py-0.5 text-[11px] text-muted hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        >
          Close
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {file === undefined ? (
          <p className="p-4 text-muted text-sm">
            {status === "loading" ? "Loading…" : "Couldn't read this file."}
          </p>
        ) : (
          <Source contents={file.contents} language={languageOf(path)} />
        )}
      </div>

      {file?.truncated === true && (
        <p className="shrink-0 border-edge border-t px-4 py-2 text-muted text-xs">
          Showing only the first part of this file — {formatSize(file.bytes)} in total.
        </p>
      )}
    </section>
  );
}

function Source({ contents, language }: { contents: string; language: string }) {
  // A trailing newline is a line break, not an empty last line to number.
  const code = contents.replace(/\n$/, "");

  return (
    <Highlight theme={THEME} code={code} language={language}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre className="w-max min-w-full py-2 font-mono text-xs leading-relaxed">
          {tokens.map((line, index) => (
            // Lines have no identity beyond their position, and the file is static while it
            // is on screen.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <div key={index} {...getLineProps({ line })} className="flex">
              <span
                aria-hidden="true"
                className="w-12 shrink-0 select-none pr-4 text-right text-edge"
              >
                {index + 1}
              </span>
              <span className="whitespace-pre pr-4">
                {line.map((token, tokenIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above
                  <span key={tokenIndex} {...getTokenProps({ token })} />
                ))}
              </span>
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
}

/** Sizes are for orientation, so one unit and no decimals is all they need to carry. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
