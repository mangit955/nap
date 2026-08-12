"use client";

/**
 * The project's files, as the agent leaves them.
 *
 * Read-only by design: this pane is a report, not an editor. What it adds over a directory
 * listing is *what just moved* — a file the current session touched is marked, and the folders
 * above it open themselves, because a mark inside a collapsed folder is a mark nobody reads.
 *
 * Split like the other two panes: the half that renders takes its data as props and is what
 * every test mounts, and the half that subscribes owns the stream and the requests.
 *
 * Directories start open. A generated project is a dozen files, and a tree that hides them
 * behind a click each shows nothing on the turn the user most wants to look.
 */

import type { FileListing } from "@nap/shared/files-protocol";
import { useEffect, useState } from "react";
import { changedPaths } from "../files/changed-paths.ts";
import { FileViewer } from "../files/file-viewer.tsx";
import { ancestorsOf, buildTree, type TreeNode } from "../files/tree.ts";
import { type LoadStatus, useFileContent, useProjectFiles } from "../files/use-project-files.ts";
import { useEventStream } from "../hooks/use-event-stream.ts";
import { isPutAway } from "../preview/preview-state.ts";
import { Pane } from "./pane.tsx";

export function FileTreePane({
  listing,
  status,
  changed,
  selected,
  onSelect,
  putAway,
}: {
  listing: FileListing | undefined;
  status: LoadStatus;
  /**
   * Whether the project has been put away, as opposed to never having had a sandbox. The
   * server cannot tell these apart — both are "no sandbox" — and they are opposite sentences.
   */
  putAway?: boolean | undefined;
  /** Project-relative paths this session has written. */
  changed: ReadonlySet<string>;
  selected: string | undefined;
  onSelect: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  // A set is a new object on every render, so the effect keys on its contents instead.
  const changedKey = [...changed].sort().join("|");

  // `changed` itself would re-run this on every render, since a set is a new object each
  // time; its contents are what decide whether anything has to open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const reveal = new Set([...changed].flatMap((path) => ancestorsOf(path)));
    if (reveal.size === 0) return;

    setCollapsed((previous) => {
      if (![...reveal].some((path) => previous.has(path))) return previous;

      const next = new Set(previous);
      for (const path of reveal) next.delete(path);
      return next;
    });
  }, [changedKey]);

  const toggle = (path: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  return (
    <Pane id="files" title="Files" chrome="none">
      {listing === undefined || listing.files.length === 0 ? (
        <Empty listing={listing} status={status} putAway={putAway} />
      ) : (
        <>
          <ul className="py-2">
            {buildTree(listing.files).map((node) => (
              <Node
                key={node.path}
                node={node}
                depth={0}
                collapsed={collapsed}
                changed={changed}
                selected={selected}
                onSelect={onSelect}
                onToggle={toggle}
              />
            ))}
          </ul>

          {listing.truncated && (
            <p className="px-4 py-2 text-muted text-xs">
              This project is large — some files are not shown.
            </p>
          )}
        </>
      )}
    </Pane>
  );
}

function Node({
  node,
  depth,
  collapsed,
  changed,
  selected,
  onSelect,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  collapsed: ReadonlySet<string>;
  changed: ReadonlySet<string>;
  selected: string | undefined;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  const indent = { paddingLeft: `${depth * 12 + 16}px` };

  if (node.type === "file") {
    const isChanged = changed.has(node.path);
    const isSelected = selected === node.path;

    return (
      <li>
        <button
          type="button"
          onClick={() => onSelect(node.path)}
          style={indent}
          className={`flex w-full items-baseline gap-2 py-0.5 pr-3 text-left font-mono text-xs focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
            isSelected ? "bg-edge text-ink" : "text-muted hover:text-ink"
          }`}
        >
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {/* In words, not colour alone — the rule the transcript follows for a failed step. */}
          {isChanged && <span className="shrink-0 text-[10px] text-accent">changed</span>}
        </button>
      </li>
    );
  }

  const isCollapsed = collapsed.has(node.path);

  return (
    <li>
      <button
        type="button"
        aria-expanded={!isCollapsed}
        onClick={() => onToggle(node.path)}
        style={indent}
        className="flex w-full items-baseline gap-1.5 py-0.5 pr-3 text-left font-mono text-ink text-xs focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        <span aria-hidden="true" className={`text-edge ${isCollapsed ? "" : "rotate-90"}`}>
          ▸
        </span>
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
      </button>

      {!isCollapsed && (
        <ul>
          {node.children.map((child) => (
            <Node
              key={child.path}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              changed={changed}
              selected={selected}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Nothing to show, for one of four quite different reasons. */
function Empty({
  listing,
  status,
  putAway,
}: {
  listing: FileListing | undefined;
  status: LoadStatus;
  putAway?: boolean | undefined;
}) {
  const message =
    listing === undefined
      ? status === "loading" || status === "idle"
        ? "Loading…"
        : "Couldn't read this project's files."
      : listing.ready
        ? "No files yet."
        : putAway === true
          ? // Its files exist; there is just nothing running to read them from. Inviting a
            // first prompt here would tell somebody with a finished app that it was empty.
            "This project is put away. Resume it to browse its files."
          : "The files the agent writes appear here.";

  return <p className="p-4 text-muted text-sm leading-relaxed">{message}</p>;
}

export function LiveFileTreePane({
  sessionId,
  putAwayAt,
  resuming,
}: {
  sessionId: string | undefined;
  /** When the record last said no sandbox was serving this project; see `isPutAway`. */
  putAwayAt?: string | undefined;
  resuming?: boolean | undefined;
}) {
  const { events } = useEventStream({ sessionId });
  // The same question the preview pane asks, answered by the same function rather than by a
  // second rule here — two panes disagreeing about whether a project is running is precisely
  // the confusion this pane's copy is trying to resolve.
  const putAway = isPutAway(events, putAwayAt) && resuming !== true;
  const { listing, status } = useProjectFiles({ sessionId, events });
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const { file, status: fileStatus } = useFileContent({ sessionId, path: selected });

  return (
    // A grid rather than a flex column: one child, stretched to fill, which is what lets the
    // viewer be positioned against this pane's own box instead of the window's.
    <div className="relative grid min-h-0 min-w-0 overflow-hidden">
      <FileTreePane
        listing={listing}
        status={status}
        putAway={putAway}
        changed={changedPaths(events)}
        selected={selected}
        onSelect={setSelected}
      />

      {selected !== undefined && (
        <FileViewer
          path={selected}
          file={file}
          status={fileStatus}
          onClose={() => setSelected(undefined)}
        />
      )}
    </div>
  );
}
