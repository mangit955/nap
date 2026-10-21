"use client";

/**
 * The agent's replies, rendered as the markdown they are written in.
 *
 * The model writes headings, lists, `code` and fenced blocks, and printed as plain text all of
 * that is asterisks and backticks. This draws it the way T3 Code's `ChatMarkdown` does (MIT —
 * see `apps/web/THIRD_PARTY_NOTICES.md`): GitHub-flavoured markdown; code blocks in a frame
 * headed by their filename, highlighted once the grammar has loaded; inline code as a small
 * bordered well; and any path into the project as a chip that opens the file in the Code tab.
 *
 * **While a reply is still arriving, `data-streaming` is set**, and the stylesheet fades each
 * newly inserted block in over 600ms. It is set only on the passage being written, so opening a
 * finished conversation shows it whole rather than replaying it.
 *
 * The component map is defined once, outside any render. react-markdown builds its tree on every
 * render, and a map created inside one would hand it new component types each time — remounting
 * every code block, and losing whether its lines were wrapped, on every streamed chunk. What the
 * renderers need from the pane — the project's files, a way to open one — comes through context
 * instead.
 */

import { Check, Copy, FileCode, WrapText } from "lucide-react";
import { createContext, use, useEffect, useRef, useState } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { fileTarget } from "./file-target.ts";
import { HighlightedCode } from "./highlight.tsx";

/** What a reply needs to know about the project to turn a path into something that opens. */
export type ProjectFilesContext = {
  files: readonly string[];
  onOpenFile: ((path: string) => void) | undefined;
};

export const ProjectFiles = createContext<ProjectFilesContext>({
  files: [],
  onOpenFile: undefined,
});

const REMARK_PLUGINS = [remarkGfm];

export function ChatMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div
      className="chat-markdown text-sm text-ink leading-[1.7]"
      data-streaming={streaming ? "" : undefined}
    >
      <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
}

type HastNode = NonNullable<ExtraProps["node"]>;

function textOf(node: HastNode | HastNode["children"][number] | undefined): string {
  if (node === undefined) return "";
  if (node.type === "text") return node.value;
  return "children" in node ? node.children.map((child) => textOf(child as HastNode)).join("") : "";
}

/** `title="App.tsx"`, `file=src/App.tsx`, or a bare filename token after the language. */
function fenceTitle(meta: unknown): string | undefined {
  if (typeof meta !== "string") return undefined;
  const attribute = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(meta);
  const named = attribute?.[1] ?? attribute?.[2] ?? attribute?.[3];
  if (named !== undefined) return named;
  const token = meta.trim().split(/\s+/)[0] ?? "";
  return /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/.test(token) ? token : undefined;
}

function CodeBlock({ node }: { node?: HastNode | undefined }) {
  const code = node?.children.find(
    (child): child is HastNode => child.type === "element" && child.tagName === "code",
  );
  const className = code?.properties.className;
  const classes = Array.isArray(className) ? className.map(String) : [];
  const language =
    classes.find((name) => name.startsWith("language-"))?.slice("language-".length) ?? "";
  const meta = (code?.data as { meta?: unknown } | undefined)?.meta;
  // A fence's text ends with the newline before its closing backticks, which is not a line.
  const source = textOf(code).replace(/\n$/, "");

  return <FramedCode code={source} language={language} title={fenceTitle(meta)} />;
}

/**
 * A fenced block in its frame: a header naming the file or the language, wrap and copy controls,
 * and the code. Wrapped by default, the way T3 opens them — a narrow chat column scrolling
 * sideways is worse than a long line breaking.
 */
function FramedCode({
  code,
  language,
  title,
}: {
  code: string;
  language: string;
  title: string | undefined;
}) {
  const [wrapped, setWrapped] = useState(true);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <div className="chat-markdown-codeblock" data-language={language} data-wrap={wrapped}>
      <div className="chat-markdown-codeblock-header flex select-none items-center justify-between gap-2 pt-1.5 pr-1.5 pb-0 pl-3">
        <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-2xs">
          <FileCode aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{title ?? (language || "text")}</span>
        </span>
        <span role="toolbar" aria-label="Code block actions" className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label={wrapped ? "Disable line wrap" : "Wrap lines"}
            aria-pressed={wrapped}
            onClick={() => setWrapped(!wrapped)}
            className={`grid size-6 place-items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 ${wrapped ? "bg-hover" : ""}`}
          >
            <WrapText aria-hidden="true" className="size-3" />
          </button>
          <button
            type="button"
            aria-label={copied ? "Copied" : "Copy code"}
            onClick={() => {
              void navigator.clipboard?.writeText(code).then(() => {
                clearTimeout(timer.current);
                setCopied(true);
                timer.current = setTimeout(() => setCopied(false), 1200);
              });
            }}
            className="grid size-6 place-items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            {copied ? (
              <Check aria-hidden="true" className="size-3" />
            ) : (
              <Copy aria-hidden="true" className="size-3" />
            )}
          </button>
        </span>
      </div>
      <pre>
        <code className="chat-markdown-shiki">
          {language === "" ? code : <HighlightedCode code={code} language={language} />}
        </code>
      </pre>
    </div>
  );
}

/**
 * A path into the project, as a chip. A button when the pane can open files — clicking it opens
 * the file in the Code tab — and a plain chip when it cannot, so it never offers a click that
 * does nothing. Sized in `em` like T3's `ContextChip`, so it sits in a line of prose or of a
 * heading without towering over either.
 */
export function FileChip({ path, label }: { path: string; label: string }) {
  const { onOpenFile } = use(ProjectFiles);
  const content = (
    <>
      <FileCode aria-hidden="true" className="size-[1.17em] shrink-0" />
      <span className="block min-w-0 truncate leading-tight">{label}</span>
    </>
  );
  const chip =
    "chat-markdown-file-link inline-flex h-[1.41em] max-w-full items-center gap-[0.33em] rounded-[0.5em] border border-edge bg-hover px-[0.5em] align-middle font-medium text-[0.86em] text-ink leading-none";

  if (onOpenFile === undefined) return <span className={chip}>{content}</span>;
  return (
    <button
      type="button"
      title={path}
      aria-label={`Open ${path}`}
      onClick={() => onOpenFile(path)}
      className={`${chip} transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink`}
    >
      {content}
    </button>
  );
}

function InlineCode({ children }: { children?: React.ReactNode }) {
  const { files } = use(ProjectFiles);
  const text = typeof children === "string" ? children : undefined;
  const path = text === undefined ? undefined : fileTarget(text, files);
  if (path !== undefined && text !== undefined) return <FileChip path={path} label={text} />;
  return <code>{children}</code>;
}

function Link({ href, children }: { href?: string | undefined; children?: React.ReactNode }) {
  const { files } = use(ProjectFiles);
  const path = href === undefined ? undefined : fileTarget(href, files);
  if (path !== undefined) {
    return <FileChip path={path} label={typeof children === "string" ? children : path} />;
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

const COMPONENTS: Components = {
  pre: CodeBlock,
  code: InlineCode,
  a: Link,
  table: ({ children }) => (
    <div className="chat-markdown-table-container">
      <table>{children}</table>
    </div>
  ),
};
