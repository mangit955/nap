import type { ReactNode } from "react";

/**
 * The chrome shared by all three panes.
 *
 * `aria-labelledby` pointing at the heading is what gives the `<section>` an accessible
 * name — and therefore the `region` role the tests query by. A `<section>` without a name
 * exposes no role at all, so this is load-bearing rather than decorative.
 *
 * The title bar is a plain `<div>` on purpose. `<header>` here would be legal HTML, but it
 * maps to the `banner` role in enough implementations that the page ends up advertising
 * four banners, and the one that matters — the app's own — stops being findable.
 */
export function Pane({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const headingId = `${id}-heading`;

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col overflow-hidden bg-panel">
      <div className="flex h-11 shrink-0 items-center justify-between border-edge border-b px-4">
        <h2 id={headingId} className="font-medium text-ink text-sm">
          {title}
        </h2>
        {action}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}
