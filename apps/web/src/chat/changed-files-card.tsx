"use client";

/**
 * What a turn changed, as a card under its answer: "3 changed files +84 −3" over a small tree.
 *
 * Cloned from T3 Code's `ChangedFilesCard` (`ChangedFilesTree.tsx`, MIT — see
 * `apps/web/THIRD_PARTY_NOTICES.md`). It stays visible when the turn folds, because "what did that
 * change?" is the question somebody skimming a finished conversation asks first. Two differences:
 * there is no "Open diff" — Nap has no diff view, and the diffs are in the work behind the fold —
 * so a file opens in the Code tab instead; and folders start open, because a Nap turn touches a
 * handful of files and a closed `src` would hide every one of them.
 */

import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileCode,
  Folder,
  FolderClosed,
} from "lucide-react";
import { use, useState } from "react";
import { ProjectFiles } from "./chat-markdown.tsx";
import { buildFileTree, type FileTreeNode } from "./file-target.ts";
import type { FileChange } from "./transcript.ts";

function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span
      role="img"
      aria-label={`${added} additions, ${removed} deletions`}
      className="inline-flex items-center gap-1 font-mono tabular-nums"
    >
      <span aria-hidden="true" className="text-ink-2">
        +{added}
      </span>
      <span aria-hidden="true" className="text-muted">
        −{removed}
      </span>
    </span>
  );
}

const ROW =
  "group flex h-7 w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70";

export function ChangedFilesCard({ files }: { files: readonly FileChange[] }) {
  const [allOpen, setAllOpen] = useState(true);
  // Folders the reader toggled, against whichever way "all" was last set.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const tree = buildFileTree(files);
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const hasDirectories = tree.some((node) => node.kind === "directory");

  return (
    <section
      aria-label="Changed files"
      className="rounded-lg bg-field"
      data-changed-files-state="tree"
    >
      <div className="sticky top-2 z-10 flex items-center justify-between gap-2 rounded-t-lg bg-field px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-medium text-ink text-xs">
          <span>
            {files.length} changed file{files.length === 1 ? "" : "s"}
          </span>
          {(added > 0 || removed > 0) && <DiffStat added={added} removed={removed} />}
        </div>
        {hasDirectories && (
          <button
            type="button"
            aria-label={allOpen ? "Collapse all folders" : "Expand all folders"}
            onClick={() => {
              setAllOpen(!allOpen);
              setOverrides({});
            }}
            className="grid size-6 place-items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            {allOpen ? (
              <ChevronsDownUp aria-hidden="true" className="size-3" />
            ) : (
              <ChevronsUpDown aria-hidden="true" className="size-3" />
            )}
          </button>
        )}
      </div>
      <div className="px-1 pb-1.5">
        <Rows
          nodes={tree}
          depth={0}
          indented={hasDirectories}
          isOpen={(path) => overrides[path] ?? allOpen}
          onToggle={(path) =>
            setOverrides((current) => ({ ...current, [path]: !(current[path] ?? allOpen) }))
          }
        />
      </div>
    </section>
  );
}

function Rows({
  nodes,
  depth,
  indented,
  isOpen,
  onToggle,
}: {
  nodes: readonly FileTreeNode[];
  depth: number;
  indented: boolean;
  isOpen: (path: string) => boolean;
  onToggle: (path: string) => void;
}) {
  const { onOpenFile } = use(ProjectFiles);

  return nodes.map((node) => {
    const paddingLeft = `${8 + depth * 14}px`;

    if (node.kind === "directory") {
      const open = isOpen(node.path);
      return (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => onToggle(node.path)}
            className={`${ROW} cursor-pointer`}
            style={{ paddingLeft }}
          >
            <ChevronRight
              aria-hidden="true"
              className={`size-3.5 shrink-0 text-muted transition-transform group-hover:text-ink-2 ${open ? "rotate-90" : ""}`}
            />
            {open ? (
              <Folder aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
            ) : (
              <FolderClosed aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
            )}
            <span className="truncate font-mono text-2xs text-muted group-hover:text-ink-2">
              {node.name}
            </span>
            <span className="ml-auto shrink-0 text-3xs">
              <DiffStat added={node.added} removed={node.removed} />
            </span>
          </button>
          {open && (
            <Rows
              nodes={node.children}
              depth={depth + 1}
              indented
              isOpen={isOpen}
              onToggle={onToggle}
            />
          )}
        </div>
      );
    }

    const content = (
      <>
        {(indented || depth > 0) && <span aria-hidden="true" className="size-3.5 shrink-0" />}
        <FileCode aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
        <span className="flex min-w-0 truncate font-mono text-ink/85 text-xs group-hover:text-ink">
          {node.name}
        </span>
        <span className="ml-auto shrink-0 text-3xs">
          <DiffStat added={node.added} removed={node.removed} />
        </span>
      </>
    );

    return onOpenFile === undefined ? (
      <div key={`file:${node.path}`} className={ROW} style={{ paddingLeft }}>
        {content}
      </div>
    ) : (
      <button
        key={`file:${node.path}`}
        type="button"
        aria-label={`Open ${node.path}`}
        onClick={() => onOpenFile(node.path)}
        className={`${ROW} cursor-pointer`}
        style={{ paddingLeft }}
      >
        {content}
      </button>
    );
  });
}
