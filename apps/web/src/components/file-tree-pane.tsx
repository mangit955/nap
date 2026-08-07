import { Pane } from "./pane.tsx";

/**
 * Placeholder. Becomes a read-only tree driven by the sandbox filesystem, with files
 * touched during the current turn highlighted.
 */

/** Shape of the generated app's template, so the placeholder shows something plausible. */
const SAMPLE = [
  { name: "src", depth: 0, kind: "dir" },
  { name: "App.tsx", depth: 1, kind: "file" },
  { name: "main.tsx", depth: 1, kind: "file" },
  { name: "index.css", depth: 1, kind: "file" },
  { name: "index.html", depth: 0, kind: "file" },
  { name: "package.json", depth: 0, kind: "file" },
] as const;

export function FileTreePane() {
  return (
    <Pane id="files" title="Files">
      <ul className="py-2 font-mono text-sm">
        {SAMPLE.map((entry) => (
          <li
            key={`${entry.depth}-${entry.name}`}
            style={{ paddingLeft: `${entry.depth * 14 + 16}px` }}
            className={entry.kind === "dir" ? "py-1 pr-4 text-ink" : "py-1 pr-4 text-muted"}
          >
            {entry.name}
          </li>
        ))}
      </ul>
    </Pane>
  );
}
