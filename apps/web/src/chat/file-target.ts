/**
 * Paths into the project, as the chat pane finds them.
 *
 * Two jobs, both about files the agent touched or talked about. `fileTarget` decides which bits
 * of a reply are a path worth turning into a chip that opens the file — the agent writes them as
 * links or, far more often, in backticks. `buildFileTree` lays a turn's changed files out the
 * way T3 Code's changed-files card does, folders first.
 */

import { toProjectPath } from "@nap/shared/files-protocol";

/** A line or a range in a file: `App.tsx:14`, `App.tsx:14:3`, `App.tsx#L14-L20`. */
const LOCATION = /(?::\d+){1,2}$|#L\d+(?:-L?\d+)?$/;

/** A path to a file: segments of ordinary name characters, the last with an extension. */
const PATH_SHAPE = /^(?:[\w@.-]+\/)+[\w@.-]*\.[A-Za-z0-9]+$/;
const FILE_NAME = /^[\w@-][\w@.-]*\.[A-Za-z0-9]+$/;

function normalise(text: string): string {
  // The tools report absolute sandbox paths; the listing is relative to the project.
  return toProjectPath(text.trim()).replace(/^\.\//, "").replace(LOCATION, "");
}

/**
 * The project path a mention points at, or undefined when it is not one.
 *
 * A path in the listing is always one. Before the listing has arrived — the first seconds of a
 * workspace, and every test that does not supply it — a mention shaped like a path with a folder
 * in it is taken at its word. Once it has, it is the answer: `node_modules/react/index.js` or
 * `example.com/index.html` is path-shaped and opens nothing. A bare filename is only a path when the project has exactly one
 * file by that name; "App.tsx" in a project with two of them would open the wrong one.
 */
export function fileTarget(text: string, files: readonly string[]): string | undefined {
  const trimmed = text.trim();
  if (/\s/.test(trimmed)) return undefined;
  // A URL is not a project path. The line number comes off first, because `App.tsx:14` begins
  // with what looks exactly like a scheme.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed.replace(LOCATION, ""))) return undefined;
  const path = normalise(trimmed);
  if (path === "") return undefined;
  if (files.includes(path)) return path;
  if (files.length === 0 && PATH_SHAPE.test(path)) return path;
  if (FILE_NAME.test(path)) {
    const matches = files.filter((file) => file.endsWith(`/${path}`));
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

export type FileTreeNode =
  | { kind: "file"; name: string; path: string; added: number; removed: number }
  | {
      kind: "directory";
      name: string;
      path: string;
      added: number;
      removed: number;
      children: FileTreeNode[];
    };

type Directory = Extract<FileTreeNode, { kind: "directory" }>;

/**
 * Changed files as a tree: folders first, in the order they were first touched, each carrying
 * the sum of its files' counts. A folder whose only child is another folder is folded into it
 * (`src/components`), so a deep path is one row rather than a staircase of them.
 */
export function buildFileTree(
  files: readonly { path: string; added: number; removed: number }[],
): FileTreeNode[] {
  const root: Directory = {
    kind: "directory",
    name: "",
    path: "",
    added: 0,
    removed: 0,
    children: [],
  };

  for (const file of files) {
    const parts = normalise(file.path).split("/");
    const name = parts.pop() ?? file.path;
    let directory = root;
    directory.added += file.added;
    directory.removed += file.removed;
    for (const part of parts) {
      const path = directory.path === "" ? part : `${directory.path}/${part}`;
      let next = directory.children.find(
        (child): child is Directory => child.kind === "directory" && child.path === path,
      );
      if (next === undefined) {
        next = { kind: "directory", name: part, path, added: 0, removed: 0, children: [] };
        directory.children.push(next);
      }
      next.added += file.added;
      next.removed += file.removed;
      directory = next;
    }
    directory.children.push({
      kind: "file",
      name,
      path: directory.path === "" ? name : `${directory.path}/${name}`,
      added: file.added,
      removed: file.removed,
    });
  }

  const compact = (node: FileTreeNode): FileTreeNode => {
    if (node.kind === "file") return node;
    let current = node;
    while (current.children.length === 1 && current.children[0]?.kind === "directory") {
      const only = current.children[0];
      current = { ...only, name: `${current.name}/${only.name}` };
    }
    const children = current.children.map(compact);
    return {
      ...current,
      children: [
        ...children.filter((child) => child.kind === "directory"),
        ...children.filter((child) => child.kind === "file"),
      ],
    };
  };

  const top = root.children.map(compact);
  return [
    ...top.filter((child) => child.kind === "directory"),
    ...top.filter((child) => child.kind === "file"),
  ];
}
