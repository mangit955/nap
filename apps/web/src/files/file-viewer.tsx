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
import { memo, useEffect } from "react";
import { CloseIcon } from "../ui/icons.tsx";
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
      <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-edge border-b px-3">
        <Breadcrumb path={path} />

        <div className="flex shrink-0 items-center gap-2">
          {/*
            The language, because a reader looking at a file with no extension — or at one whose
            highlighting looks wrong — has no other way to find out what Prism decided it was.
          */}
          <span className="rounded-[5px] bg-hover px-1.5 py-px font-mono text-[10px] text-muted uppercase tracking-wide">
            {languageOf(path)}
          </span>

          <button
            type="button"
            aria-label="Close this file"
            onClick={onClose}
            className="grid size-6 place-items-center rounded text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          >
            <CloseIcon className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="nap-scroll min-h-0 flex-1 overflow-auto">
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

/**
 * Where the file sits, with the filename picked out of it.
 *
 * A path set in one weight is a string somebody has to parse; the part that answers "which file
 * am I looking at" is the last segment, so it gets the ink and the directories recede.
 */
function Breadcrumb({ path }: { path: string }) {
  const segments = path.split("/");
  const name = segments.at(-1) ?? path;
  const directories = segments.slice(0, -1);

  return (
    <span className="min-w-0 truncate font-mono text-[12px]">
      {directories.map((segment, index) => (
        // Segments repeat within one path (`src/components/src`), so the name alone is not a
        // key; the prefix up to this point is unique by construction.
        // biome-ignore lint/suspicious/noArrayIndexKey: the index *is* the identity here
        <span key={`${segment}-${index}`} className="text-muted">
          {segment}/
        </span>
      ))}
      <span className="text-ink">{name}</span>
    </span>
  );
}

/**
 * The highlighted file.
 *
 * **Memoised, and that is load-bearing rather than tidy.** The Code pane subscribes to the
 * session's event stream, so every streamed token re-renders it — and Prism re-tokenises the
 * *entire* open file on each render. During a turn that is dozens of full re-tokenisations a
 * second, on the same thread the transcript is trying to animate on. Both props are primitives,
 * so the default comparison is exactly right.
 */
const Source = memo(function Source({
  contents,
  language,
}: {
  contents: string;
  language: string;
}) {
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
              {/*
                `sticky left-0` so the numbers survive scrolling sideways through a long line —
                a gutter that slides off the left edge takes the reader's place in the file with
                it. It needs its own opaque background for that, which is also what separates it
                from the code the way an editor's does.

                The colour is `gutter` rather than `edge`: `edge` is a *border* value and
                measures about 1.2:1 against this surface, so the numbers were in the markup and
                invisible on screen.
              */}
              <span
                aria-hidden="true"
                className="sticky left-0 w-12 shrink-0 select-none border-edge border-r bg-panel pr-3 text-right text-gutter"
              >
                {index + 1}
              </span>
              <span className="whitespace-pre pr-4 pl-4">
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
});

/** Sizes are for orientation, so one unit and no decimals is all they need to carry. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
