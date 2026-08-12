/**
 * A flat list of paths, as a tree.
 *
 * The server answers with every path in one response, so this is a fold rather than a
 * fetching strategy: expanding a folder, revealing the file that just changed and collapsing
 * it again are all local, and none of them costs a request.
 *
 * Directories come before files at each level. A project is read top-down for its shape, and
 * interleaving the two by name turns "where does the source live" into a scan.
 */

export type TreeNode =
  | { type: "directory"; name: string; path: string; children: TreeNode[] }
  | { type: "file"; name: string; path: string };

export function buildTree(paths: readonly string[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const path of paths) {
    const segments = path.split("/");
    let level = root;
    let prefix = "";

    for (const [index, segment] of segments.entries()) {
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;

      if (index === segments.length - 1) {
        level.push({ type: "file", name: segment, path: prefix });
        break;
      }

      const existing = level.find(
        (node): node is Extract<TreeNode, { type: "directory" }> =>
          node.type === "directory" && node.name === segment,
      );

      if (existing !== undefined) {
        level = existing.children;
        continue;
      }

      const created: TreeNode = { type: "directory", name: segment, path: prefix, children: [] };
      level.push(created);
      level = created.children;
    }
  }

  return sort(root);
}

function sort(nodes: TreeNode[]): TreeNode[] {
  for (const node of nodes) {
    if (node.type === "directory") sort(node.children);
  }

  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The tree narrowed to a query.
 *
 * Two rules, and the second is the one that is easy to get wrong. A **file** is kept when its
 * whole path contains the query — the path and not just the name, because "src/App" is how
 * somebody tells two files called `App.tsx` apart. A **directory** is kept when its own path
 * matches, in which case everything under it comes too, *or* when anything under it survived.
 *
 * Without the first half of that rule, typing "lib" answers with nothing: there is no file
 * called lib, only a folder, and a filter that cannot find a folder by name reads as broken.
 * Without the second half, a search for one file leaves every ancestor folder on screen empty,
 * which reads as contents that failed to load.
 *
 * Pure, and returns new nodes rather than mutating: the unfiltered tree is what the pane goes
 * back to when the box is cleared.
 */
export function filterTree(nodes: readonly TreeNode[], query: string): TreeNode[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return nodes as TreeNode[];

  const keep = (node: TreeNode): TreeNode | undefined => {
    const matches = node.path.toLowerCase().includes(needle);

    if (node.type === "file") return matches ? node : undefined;
    // A matching folder brings its contents with it, unfiltered — the query named the folder,
    // so what is in it is the answer.
    if (matches) return node;

    const children = node.children.map(keep).filter((child) => child !== undefined);
    return children.length === 0 ? undefined : { ...node, children };
  };

  return nodes.map(keep).filter((node) => node !== undefined);
}

/** Every directory on the way to a file — what has to be open for it to be visible. */
export function ancestorsOf(path: string): string[] {
  const segments = path.split("/").slice(0, -1);

  return segments.map((_segment, index) => segments.slice(0, index + 1).join("/"));
}
