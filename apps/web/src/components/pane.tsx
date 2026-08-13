import type { ReactNode } from "react";

/**
 * The chrome shared by the panes.
 *
 * `aria-labelledby` pointing at the heading is what gives the `<section>` an accessible
 * name — and therefore the `region` role the tests query by. A `<section>` without a name
 * exposes no role at all, so this is load-bearing rather than decorative.
 *
 * **`chrome: "none"` hides the title bar without hiding the name.** The workspace's panes have
 * no headings of their own any more — one bar across the top says which project this is and
 * which half of the workbench is showing, and a second row of titles under it would be the same
 * information twice. The heading stays in the document, visually hidden, because it is what
 * makes the region findable to a reader; deleting it would take the landmark with it.
 *
 * The title bar is a plain `<div>` on purpose. `<header>` here would be legal HTML, but it
 * maps to the `banner` role in enough implementations that the page ends up advertising
 * several banners, and the one that matters — the app's own — stops being findable.
 */
export function Pane({
  id,
  title,
  action,
  chrome = "bar",
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  /** `none` keeps the accessible name and drops the visible title bar. */
  chrome?: "bar" | "none";
  children: ReactNode;
}) {
  const headingId = `${id}-heading`;

  return (
    <section
      aria-labelledby={headingId}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-panel"
    >
      {chrome === "bar" ? (
        <div className="flex h-11 shrink-0 items-center justify-between border-edge border-b px-4">
          <h2 id={headingId} className="font-medium text-ink text-sm">
            {title}
          </h2>
          {action}
        </div>
      ) : (
        <h2 id={headingId} className="sr-only">
          {title}
        </h2>
      )}
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}
