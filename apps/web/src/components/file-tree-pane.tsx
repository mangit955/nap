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
import { useEffect, useMemo, useState } from "react";
import { changedPaths } from "../files/changed-paths.ts";
import { FileViewer } from "../files/file-viewer.tsx";
import { ancestorsOf, buildTree, filterTree, type TreeNode } from "../files/tree.ts";
import { type LoadStatus, useFileContent, useProjectFiles } from "../files/use-project-files.ts";
import { useEventStream } from "../hooks/use-event-stream.ts";
import { isPutAway } from "../preview/preview-state.ts";
import { ChevronRight, CloseIcon, FileIcon, FolderIcon, SearchIcon } from "../ui/icons.tsx";
import { Pane } from "./pane.tsx";

export function FileTreePane({
  listing,
  status,
  changed,
  selected,
  onSelect,
  onPrefetch,
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
  /**
   * Reads a file before it is clicked. Optional so the render tests need not supply one — a
   * tree that cannot prefetch is slower, not broken.
   */
  onPrefetch?: ((path: string) => void) | undefined;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");

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

  // Rebuilt only when the files or the query change. Without this both pure functions run on
  // every render of a pane that is subscribed to the event stream — which is every streamed
  // token of every turn, to produce the same tree each time.
  const files = listing?.files;
  const tree = useMemo(() => filterTree(buildTree(files ?? []), query), [files, query]);

  return (
    <Pane id="files" title="Files" chrome="none">
      <div className="flex h-full min-h-0 flex-col">
        {/*
          The header is drawn whatever the tree says, so the filter does not appear and disappear
          under the cursor as a project's first files land.
        */}
        <div className="flex h-9 shrink-0 items-center gap-2 border-edge border-b px-2.5">
          <SearchIcon className="size-3.5 shrink-0 text-muted" />
          <input
            aria-label="Filter files"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Files"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-muted"
          />
          {query !== "" && (
            <button
              type="button"
              aria-label="Clear the filter"
              onClick={() => setQuery("")}
              className="grid size-5 shrink-0 place-items-center rounded text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            >
              <CloseIcon className="size-3" />
            </button>
          )}
        </div>

        <div className="nap-scroll min-h-0 flex-1 overflow-auto py-1.5">
          {listing === undefined || listing.files.length === 0 ? (
            <Empty listing={listing} status={status} putAway={putAway} />
          ) : tree.length === 0 ? (
            <p className="px-3 py-2 text-[12.5px] text-muted">No file matches “{query}”.</p>
          ) : (
            <>
              <ul>
                {tree.map((node) => (
                  <Node
                    key={node.path}
                    node={node}
                    depth={0}
                    collapsed={collapsed}
                    changed={changed}
                    selected={selected}
                    onSelect={onSelect}
                    onToggle={toggle}
                    {...(onPrefetch === undefined ? {} : { onPrefetch })}
                  />
                ))}
              </ul>

              {listing.truncated && (
                <p className="px-3 py-2 text-muted text-xs">
                  This project is large — some files are not shown.
                </p>
              )}
            </>
          )}
        </div>
      </div>
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
  onPrefetch,
}: {
  node: TreeNode;
  depth: number;
  collapsed: ReadonlySet<string>;
  changed: ReadonlySet<string>;
  selected: string | undefined;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  onPrefetch?: ((path: string) => void) | undefined;
}) {
  // The chevron column is reserved on file rows too, so filenames line up with the folder names
  // above them instead of sitting a character to the left of them.
  const indent = { paddingLeft: `${depth * 12 + 8}px` };

  /*
   * Sans, not mono. The tree is navigation — a column of names to aim at — and mono here reads
   * as terminal output, sets the names wider than they need to be, and costs the tree a couple
   * of characters of width it does not have to spare. Source stays mono in the viewer, where it
   * is being read as code.
   */
  const row =
    "group flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent";

  if (node.type === "file") {
    const isChanged = changed.has(node.path);
    const isSelected = selected === node.path;

    return (
      <li className="px-1">
        <button
          type="button"
          onClick={() => onSelect(node.path)}
          /*
           * Read on intent, not on the click. A pointer arrives on a row 100–300ms before the
           * button goes down, and a file read is a round trip to the sandbox — so this is most
           * of the wait, taken for free. `onFocus` covers keyboard navigation, which hover
           * never does. Both are cheap: the hook drops a path already cached or in flight.
           */
          onPointerEnter={() => onPrefetch?.(node.path)}
          onFocus={() => onPrefetch?.(node.path)}
          style={indent}
          className={`${row} ${
            isSelected ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
          }`}
        >
          <span aria-hidden="true" className="size-4 shrink-0" />
          <FileIcon className="size-3.5 shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {/*
            A dot rather than the word, which used to eat a third of a narrow tree's width and
            truncate the filename beside it. The word survives for anybody listening — the rule
            the transcript follows for a failed step is that state is never colour alone.
          */}
          {isChanged && (
            <>
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent" />
              <span className="sr-only">changed</span>
            </>
          )}
        </button>
      </li>
    );
  }

  const isCollapsed = collapsed.has(node.path);

  return (
    <li className="px-1">
      <button
        type="button"
        aria-expanded={!isCollapsed}
        onClick={() => onToggle(node.path)}
        style={indent}
        className={`${row} text-ink hover:bg-hover`}
      >
        <ChevronRight
          className={`size-4 shrink-0 text-muted transition-transform duration-150 ${
            isCollapsed ? "" : "rotate-90"
          }`}
        />
        <FolderIcon className="size-3.5 shrink-0 text-muted" />
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
              {...(onPrefetch === undefined ? {} : { onPrefetch })}
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
